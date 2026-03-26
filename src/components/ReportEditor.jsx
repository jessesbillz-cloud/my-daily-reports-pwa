import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { C } from '../constants/theme';
import { db } from '../utils/db';
import { AUTH_TOKEN, refreshAuthToken, authDiag, preflightCheck } from '../utils/auth';
import { SB_URL, VIS_COMPANY_ID, TYR_COMPANY_ID, ENHANCED_TYR_ID } from '../constants/supabase';
import { generateTYR } from '../utils/tyr-generator';
import { generateVIS } from '../utils/vis-generator';
import { api } from '../utils/api';
import { ensurePdfLib, ensurePdfJs, ensureMammoth } from '../utils/pdf';
import { askConfirm } from './ConfirmOverlay';
import { buildAutoFillData } from '../utils/auth';
import { AI_DESCRIBE_DAILY_LIMIT, getAiUsageCount, checkAiLimit, incrementAiUsage } from '../utils/ai-usage';

function ReportEditor({job, user, onBack, reportDate}){
  const fc=job.field_config||{editable:[],locked:[]};
  // Deduplicate notes-like fields from existing configs (fix for old jobs with duplicates)
  const NOTES_KW=["notes","observations","comments"];
  const isNotes=(n)=>NOTES_KW.some(k=>(n||"").toLowerCase().includes(k));
  const dedupNotes=(arr)=>{let found=false;return(arr||[]).filter(f=>{if(!isNotes(f.name))return true;if(found)return false;found=true;return true;});};
  const rawEdit=dedupNotes([...(fc.editable||[])]);
  const editHasNotes=rawEdit.some(f=>isNotes(f.name));
  const initEdit=rawEdit;
  // If editable already has a notes field, remove any notes from locked too
  const initLock=editHasNotes?[...(fc.locked||[])].filter(f=>!isNotes(f.name)):dedupNotes([...(fc.locked||[])]);
  const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Use reportDate if editing a specific past date, otherwise always compute fresh "today"
  const getTodayISO=()=>reportDate||new Date().toLocaleDateString("en-CA",{timeZone:tz});
  const todayISO=getTodayISO();
  const todayDisplay=new Date(todayISO+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric",timeZone:tz});

  // Mutable field lists — locked fields can be unlocked/relocked
  const [lockFields,setLockFields]=useState(initLock);
  const [editFields,setEditFields]=useState(initEdit);
  const [showLocked,setShowLocked]=useState(false);
  const [lockEditing,setLockEditing]=useState(false);
  const [lockVals,setLockVals]=useState(()=>{const v={};initLock.forEach(f=>{v[f.name]=f.value||"";});return v;});
  const [loadingDraft,setLoadingDraft]=useState(true);
  const [draftId,setDraftId]=useState(null);
  const [editFilename,setEditFilename]=useState(""); // editable filename shown in header
  const [filenameEdited,setFilenameEdited]=useState(false); // user manually changed it

  // Smart date formatter — matches the format from the original template value
  // Uses the report date context (today or a specific past date being edited)
  const formatAutoDate=(originalVal)=>{
    const now=reportDate?new Date(reportDate+"T12:00:00"):new Date();
    const orig=(originalVal||"").trim();
    // "04 February 2026" or "4 February 2026" → day month year (long)
    if(/^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(orig)){
      const padDay=orig.startsWith("0");
      return now.toLocaleDateString("en-US",{day:padDay?"2-digit":"numeric",month:"long",year:"numeric",timeZone:tz}).replace(/^(\w+)\s(\d+),\s(\d+)$/,(_,m,d,y)=>`${padDay?d.padStart(2,"0"):d} ${m} ${y}`);
    }
    // "February 04, 2026" → month day, year
    if(/^[A-Za-z]+\s+\d{1,2},?\s+\d{4}$/.test(orig))return now.toLocaleDateString("en-US",{month:"long",day:"2-digit",year:"numeric",timeZone:tz});
    // "Feb 04, 2026" → short month
    if(/^[A-Za-z]{3}\s+\d{1,2},?\s+\d{4}$/.test(orig))return now.toLocaleDateString("en-US",{month:"short",day:"2-digit",year:"numeric",timeZone:tz});
    // "2026-02-04" → ISO
    if(/^\d{4}-\d{2}-\d{2}$/.test(orig))return now.toLocaleDateString("en-CA",{timeZone:tz});
    // Default: "3/7/2026" US short
    return now.toLocaleDateString("en-US",{timeZone:tz});
  };

  // Editable field values
  const isAcroForm=fc.source==="acroform";
  const autoData=isAcroForm?buildAutoFillData(job,user,reportDate?reportDate:null):{};
  const [vals,setVals]=useState(()=>{
    const v={};
    initEdit.forEach(f=>{
      if(f.autoFill==="date")v[f.name]=formatAutoDate(f.originalValue||f.value);
      else if(f.autoFill==="increment")v[f.name]="";
      else if(f.autoFill==="name")v[f.name]=window._mdrUserName||f.value||"";
      else if(isAcroForm&&f.autoFill&&autoData[f.autoFill])v[f.name]=autoData[f.autoFill];
      else v[f.name]=""; // Start blank for editable fields — draft loading will populate if a saved report exists
    });
    // Also set locked field vals from auto-fill data for AcroForm
    if(isAcroForm){
      initLock.forEach(f=>{
        if(f.autoFill&&autoData[f.autoFill]&&!f.value)lockVals[f.name]=autoData[f.autoFill];
      });
    }
    return v;
  });
  const [saving,setSaving]=useState(false);

  // Photo state
  const [photos,setPhotos]=useState([]);
  const [photoLayout,setPhotoLayout]=useState("2"); // "1","2","4"
  const photoRef=useRef(null);

  // Downscale image for AI vision — 800px max, lower quality
  const downscaleForAI=(dataUrl)=>new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      const MAX=800;
      let w=img.width,h=img.height;
      if(w<=MAX&&h<=MAX){resolve(dataUrl);return;}
      const r=Math.min(MAX/w,MAX/h);w=Math.round(w*r);h=Math.round(h*r);
      const cvs=document.createElement("canvas");cvs.width=w;cvs.height=h;
      cvs.getContext("2d").drawImage(img,0,0,w,h);
      resolve(cvs.toDataURL("image/jpeg",0.5));
    };
    img.onerror=()=>resolve(dataUrl);
    img.src=dataUrl;
  });

  // AI photo description
  const [aiDescribing,setAiDescribing]=useState({});
  const [aiUsageCount,setAiUsageCount]=useState(getAiUsageCount(job?.id));
  const aiLimitReached=aiUsageCount>=AI_DESCRIBE_DAILY_LIMIT;
  const describePhoto=async(imageDataUrl,context,uniqueId)=>{
    if(!checkAiLimit(job?.id)){showToast(`AI limit reached (${AI_DESCRIBE_DAILY_LIMIT}/day). Resets tomorrow.`);return null;}
    setAiDescribing(p=>({...p,[uniqueId]:true}));
    try{
      const aiImg=await downscaleForAI(imageDataUrl);
      const b64=aiImg.includes(",")?aiImg.split(",")[1]:aiImg;
      const formData=new FormData();
      formData.append('image_base64',b64);
      formData.append('context',context);
      const data=await api.describePhoto(formData);
      incrementAiUsage(job?.id);
      setAiUsageCount(getAiUsageCount(job?.id));
      return data.description||"";
    }catch(e){
      console.error("[AI describe]",e);
      showToast("AI describe failed — try again");
      return null;
    }finally{
      setAiDescribing(p=>({...p,[uniqueId]:false}));
    }
  };

  const [reportStatus,setReportStatus]=useState(null);
  // ── TYR v3: scoped contractor picker ──
  const isTYR=job.company_id===TYR_COMPANY_ID;           // Original TYR template
  const isEnhancedTYR=job.company_id===ENHANCED_TYR_ID;  // V5 fixed template
  const isAnyTYR=isTYR||isEnhancedTYR;                   // Shared TYR behavior
  const isVIS=job.company_id===VIS_COMPANY_ID;            // VIS - Vital Inspection Services
  const isFromScratch=isTYR||isVIS;                       // From-scratch PDF generators
  const [jobContractors,setJobContractors]=useState([]);
  const [selectedContractors,setSelectedContractors]=useState([]);
  const toggleContractor=(name)=>{setSelectedContractors(p=>{const exists=p.find(c=>c.company_name===name);if(exists)return p.filter(c=>c.company_name!==name);return[...p,{company_name:name,manpower:0,hours_regular:0,hours_overtime:0}];});};
  const updateContractorManpower=(name,val)=>{setSelectedContractors(p=>p.map(c=>c.company_name===name?{...c,manpower:parseInt(val)||0}:c));};
  const updateContractorHours=(name,field,val)=>{setSelectedContractors(p=>p.map(c=>c.company_name===name?{...c,[field]:parseFloat(val)||0}:c));};
  const updateContractorEquipment=(name,val)=>{setSelectedContractors(p=>p.map(c=>c.company_name===name?{...c,equipment:val}:c));};
  const updateContractorTrade=(name,val)=>{setSelectedContractors(p=>p.map(c=>c.company_name===name?{...c,trade:val}:c));};
  useEffect(()=>{if(!isAnyTYR)return;(async()=>{try{const c=await db.getJobContractors(job.id);setJobContractors(c);}catch(e){console.error("Load contractors:",e);}})();},[job.id,isAnyTYR]);
  // TYR v4: Auto-fill general statement from job settings into matching field
  useEffect(()=>{if(!isAnyTYR||!job.general_statement)return;const gsField=editFields.find(f=>/general.?statement/i.test(f.name||""));if(gsField&&!vals[gsField.name]){setVals(p=>({...p,[gsField.name]:job.general_statement}));}},[ isAnyTYR,editFields.length]);

  // TYR v5: Weather toggle + auto-fetch
  const [tyrWeatherOn,setTyrWeatherOn]=useState(false);
  const [tyrWeather,setTyrWeather]=useState("");
  const [tyrWeatherLoading,setTyrWeatherLoading]=useState(false);
  const fetchTyrWeather=async()=>{
    if(!job.site_address){showToast("Add a site address in Job Settings to enable weather");return;}
    setTyrWeatherLoading(true);
    try{
      let lat,lng;
      try{const geoR=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(job.site_address)}&format=json&limit=1`,{headers:{"User-Agent":"MyDailyReports/1.0"}});const geoD=await geoR.json();if(geoD&&geoD.length>0){lat=parseFloat(geoD[0].lat);lng=parseFloat(geoD[0].lon);}}catch(e){}
      if(!lat||!lng){try{const cityMatch=job.site_address.match(/,\s*([^,]+),?\s*[A-Z]{2}/);const searchName=cityMatch?cityMatch[1].trim():job.site_address;const geoR2=await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchName)}&count=1&language=en&format=json`);const geoD2=await geoR2.json();if(geoD2.results&&geoD2.results.length>0){lat=geoD2.results[0].latitude;lng=geoD2.results[0].longitude;}}catch(e){}}
      if(!lat||!lng){showToast("Could not find location");setTyrWeatherLoading(false);return;}
      const wxR=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`);
      const wxD=await wxR.json();
      if(wxD.current){
        const t=Math.round(wxD.current.temperature_2m);
        const wmo={0:"Clear",1:"Mostly Clear",2:"Partly Cloudy",3:"Overcast",45:"Foggy",51:"Light Drizzle",61:"Light Rain",63:"Rain",65:"Heavy Rain",71:"Light Snow",73:"Snow",80:"Showers",95:"Thunderstorm"};
        const desc=wmo[wxD.current.weather_code]||"";
        const wind=Math.round(wxD.current.wind_speed_10m);
        const wxStr=`${desc} ${t}°F, Wind ${wind} mph`;
        setTyrWeather(wxStr);
        // Auto-fill the Weather field in the form
        const wxField=[...editFields,...lockFields].find(f=>/weather/i.test(f.name||""));
        if(wxField){if(editFields.find(ef=>ef.name===wxField.name))setVals(p=>({...p,[wxField.name]:wxStr}));else setLockVals(p=>({...p,[wxField.name]:wxStr}));}
      }
    }catch(e){console.error("Weather fetch:",e);showToast("Weather fetch failed");}
    finally{setTyrWeatherLoading(false);}
  };
  const toggleTyrWeather=(on)=>{
    if(on&&!job.site_address){showToast("Add a site address in Job Settings to enable weather");return;}
    setTyrWeatherOn(on);
    if(on&&!tyrWeather)fetchTyrWeather();
  };

  // Load existing report on mount (works for both working_copy and submitted)
  useEffect(()=>{
    (async()=>{
      try{
        const rpt=await db.getReport(job.id,todayISO);
        // Fetch next report number for auto-# fields
        let nextReportNum=1;
        try{
          const cntR=await fetch(`${SB_URL}/rest/v1/reports?select=report_number&job_id=eq.${job.id}&order=report_number.desc&limit=1`,{headers:db._h()});
          const topR=cntR.ok?await cntR.json():[];
          if(topR[0]?.report_number){nextReportNum=topR[0].report_number+1;}
          else{const countR=await fetch(`${SB_URL}/rest/v1/reports?select=id&job_id=eq.${job.id}&limit=0`,{headers:{...db._h(),Prefer:"count=exact"}});const total=parseInt(countR.headers.get("content-range")?.split("/")[1]||"0");nextReportNum=total+1;}
        }catch(numErr){console.error("Report number fetch:",numErr);}
        // If editing an existing report, use its number instead
        if(rpt&&rpt.report_number)nextReportNum=rpt.report_number;
        // Fill auto-# fields with the computed number
        const conv=job.field_config?.filenameConvention||{};
        const padding=conv.numberPadding||0;
        const numStr=padding>0?String(nextReportNum).padStart(padding,"0"):String(nextReportNum);
        const autoNumVals={};
        initEdit.forEach(f=>{if(f.autoFill==="increment")autoNumVals[f.name]=numStr;});
        if(Object.keys(autoNumVals).length>0)setVals(p=>({...p,...autoNumVals}));
        if(rpt){
          setReportStatus(rpt.status);
          setDraftId(rpt.id);
          if(rpt.content){
            let c;try{c=typeof rpt.content==="string"?JSON.parse(rpt.content):rpt.content;}catch(pe){console.error("Corrupt report content:",pe);c={};}
            if(c.vals){
              // Merge saved values but re-apply today's date and auto-# for auto fields (matching original format)
              const merged={...c.vals};
              initEdit.forEach(f=>{
                if(f.autoFill==="date")merged[f.name]=formatAutoDate(f.originalValue||f.value);
                if(f.autoFill==="increment")merged[f.name]=numStr;
                if(f.autoFill==="name"&&window._mdrUserName)merged[f.name]=window._mdrUserName;
              });
              setVals(p=>({...p,...merged}));
            }
            if(c.lockVals)setLockVals(p=>({...p,...c.lockVals}));
            if(c.photos)setPhotos(c.photos);
            if(c.photoLayout)setPhotoLayout(c.photoLayout);
            if(isAnyTYR&&c.contractors)setSelectedContractors(c.contractors);
            if(c.sigTimestamps)setSigTimestamps(c.sigTimestamps);
            // Apply notes dedup to restored fields (fixes old drafts saved with duplicates)
            if(c.lockFields){const editHasN=(c.editFields||initEdit).some(f=>isNotes(f.name));setLockFields(editHasN?c.lockFields.filter(f=>!isNotes(f.name)):dedupNotes(c.lockFields));}
            if(c.editFields)setEditFields(dedupNotes(c.editFields));
          }
        }
      }catch(e){console.error("Load report error:",e);}
      finally{
        // Compute preview filename
        try{
          const conv=job.field_config?.filenameConvention||{};
          const padding=conv.numberPadding||0;
          const numStr=padding>0?String(nextReportNum).padStart(padding,"0"):String(nextReportNum);
          const now=reportDate?new Date(reportDate+"T12:00:00"):new Date();
          const fmtMM=now.toLocaleDateString("en-US",{month:"2-digit",timeZone:tz});
          const fmtDD=now.toLocaleDateString("en-US",{day:"2-digit",timeZone:tz});
          const fmtYYYY=now.toLocaleDateString("en-US",{year:"numeric",timeZone:tz});
          const monNames=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const monthIdx=now.toLocaleDateString("en-US",{month:"numeric",timeZone:tz})-1;
          const fmtMon=monNames[monthIdx]||"";
          const fmtDay=String(parseInt(fmtDD));
          const fnP=conv.pattern||job.report_filename_pattern||job.name||"Report";
          let fn=fnP.replace(/\.[^.]+$/,"");
          const hasDate=fn.includes("{date}")||fn.includes("{year}");
          const hasNum=fn.includes("{report_number}");
          fn=fn.replace(/\{report_number\}/g,numStr);
          fn=fn.replace(/\{date\}/g,conv.dateFormat?conv.dateFormat.replace(/YYYY/g,fmtYYYY).replace(/MM/g,fmtMM).replace(/DD/g,fmtDD).replace(/Month/g,(["January","February","March","April","May","June","July","August","September","October","November","December"][monthIdx]||"")).replace(/Mon/g,fmtMon):now.toLocaleDateString("en-US",{timeZone:tz}));
          fn=fn.replace(/\{year\}/g,fmtYYYY);
          fn=fn.replace(/\{project\}/g,(job.name||"").replace(/\s+/g,"_"));
          if(!hasDate){const litRx=/(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s_]+\d{1,2}[,\s_]+\d{4}/;const ds=fmtMon+" "+fmtDay+"_"+fmtYYYY;if(litRx.test(fn))fn=fn.replace(litRx,ds);else fn+="_"+ds;}
          if(!hasNum){const rp=fn.replace(/_(\d+)(?=_)/,()=>"_"+numStr);if(rp===fn)fn=numStr+"_"+fn;else fn=rp;}
          setEditFilename(fn);
        }catch(fnErr){setEditFilename(job.name||"Report");}
        setLoadingDraft(false);
      }
    })();
  },[]);

  const [fieldMode,setFieldMode]=useState(false);
  const [contractorsOpen,setContractorsOpen]=useState(true);
  const [autoFilledOpen,setAutoFilledOpen]=useState(false);
  const fieldPhotoRef=useRef(null);
  const [cameraOpen,setCameraOpen]=useState(false);
  const videoRef=useRef(null);
  const streamRef=useRef(null);

  const openCamera=async()=>{
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment",width:{ideal:1920},height:{ideal:1080}},audio:false});
      streamRef.current=stream;
      setCameraOpen(true);
      // Wait for video element to mount, then attach stream
      setTimeout(()=>{if(videoRef.current){videoRef.current.srcObject=stream;videoRef.current.play();}},50);
    }catch(err){
      console.warn("Camera API failed, falling back to file input:",err);
      fieldPhotoRef.current?.click();
    }
  };

  const takePhoto=async()=>{
    if(!videoRef.current)return;
    const v=videoRef.current;
    const cvs=document.createElement("canvas");
    cvs.width=v.videoWidth;cvs.height=v.videoHeight;
    cvs.getContext("2d").drawImage(v,0,0);
    const dataUrl=cvs.toDataURL("image/jpeg",0.8);
    const compressed=await compressFieldPhoto(dataUrl);
    setPhotos(p=>[...p,{id:Date.now()+Math.random(),src:compressed,name:`photo-${Date.now()}.jpg`}]);
    closeCamera();
  };

  const closeCamera=()=>{
    if(streamRef.current){streamRef.current.getTracks().forEach(t=>t.stop());streamRef.current=null;}
    setCameraOpen(false);
  };

  const [sigTimestamps,setSigTimestamps]=useState({});
  const setVal=(name,val)=>{
    setVals(p=>({...p,[name]:val}));
    // Record timestamp when a signature field is signed
    const isSigField=[...editFields,...lockFields].find(f=>f.name===name&&((f.name||"").toLowerCase().includes("signature")||(f.autoFill==="name"&&(f.name||"").toLowerCase().includes("inspector"))));
    if(isSigField&&val)setSigTimestamps(p=>({...p,[name]:new Date().toISOString()}));
  };
  const setLockVal=(name,val)=>setLockVals(p=>({...p,[name]:val}));

  // Permanently unlock a locked field — moves it to editable
  const unlockField=(name)=>{
    const f=lockFields.find(x=>x.name===name);
    if(!f)return;
    const newLock=lockFields.filter(x=>x.name!==name);
    const newEdit=[...editFields,{...f,value:lockVals[name]||f.value||"",voiceEnabled:false,wasUnlocked:true}];
    setLockFields(newLock);
    setEditFields(newEdit);
    setVals(p=>({...p,[name]:lockVals[name]||f.value||""}));
    // Persist — merge into existing field_config to preserve signatures, source, etc.
    const merged={...fc,locked:newLock,editable:newEdit};
    db.updateJobFieldConfig(job.id,merged).then(()=>{
      job.field_config=merged;
    }).catch(e=>console.error("Field config update error:",e));
  };

  // Skip/unskip a field for today (ghost it out without removing it)
  const [skippedFields,setSkippedFields]=useState({});
  const toggleSkipField=(name)=>{
    setSkippedFields(p=>({...p,[name]:!p[name]}));
  };

  // Lock an editable field — saves value and moves to locked section (admin use)
  const relockField=(name)=>{
    const f=editFields.find(x=>x.name===name);
    if(!f)return;
    const val=vals[name]||f.value||"";
    const newEdit=editFields.filter(x=>x.name!==name);
    const restored={...f,value:val};
    const newLock=[...lockFields,restored];
    setEditFields(newEdit);
    setLockFields(newLock);
    setLockVals(p=>({...p,[name]:val}));
    // Remove from editable vals
    setVals(p=>{const n={...p};delete n[name];return n;});
    // Persist — merge into existing field_config to preserve signatures, source, etc.
    const merged={...fc,locked:newLock,editable:newEdit};
    db.updateJobFieldConfig(job.id,merged).then(()=>{
      job.field_config=merged;
      showToast(`"${name}" locked`);
    }).catch(e=>{console.error("Field config update error:",e);showToast("Lock failed: "+e.message);});
  };

  // Save locked field value changes back to job config
  const saveLockEdits=()=>{
    const updated=lockFields.map(f=>({...f,value:lockVals[f.name]||f.value}));
    setLockFields(updated);
    setLockEditing(false);
    // Persist — merge into existing field_config to preserve signatures, source, etc.
    const merged={...fc,locked:updated,editable:editFields};
    db.updateJobFieldConfig(job.id,merged).then(()=>{
      job.field_config=merged;
    }).catch(e=>console.error("Field config update error:",e));
  };

  // Compress/rotate photo via canvas (fixes EXIF orientation for pdf-lib)
  // Max 1200px and quality 0.6 to keep save payloads under control
  const compressFieldPhoto=(dataUrl)=>new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      const MAX=1200;
      let w=img.naturalWidth,h=img.naturalHeight;
      if(w>MAX||h>MAX){const r=Math.min(MAX/w,MAX/h);w=Math.round(w*r);h=Math.round(h*r);}
      const cvs=document.createElement("canvas");cvs.width=w;cvs.height=h;
      cvs.getContext("2d").drawImage(img,0,0,w,h);
      resolve(cvs.toDataURL("image/jpeg",0.6));
    };
    img.onerror=()=>resolve(dataUrl);
    img.src=dataUrl;
  });
  const handlePhoto=(e)=>{
    const files=Array.from(e.target.files||[]);
    files.forEach(file=>{
      const reader=new FileReader();
      reader.onload=async(ev)=>{
        const compressed=await compressFieldPhoto(ev.target.result);
        setPhotos(p=>[...p,{id:Date.now()+Math.random(),src:compressed,name:file.name}]);
      };
      reader.readAsDataURL(file);
    });
    // Reset input so same file can be re-selected
    e.target.value="";
    if(photoRef.current)photoRef.current.value="";
    if(fieldPhotoRef.current)fieldPhotoRef.current.value="";
  };

  const reSavingRef=useRef(false);
  const saveWorking=async()=>{
    if(reSavingRef.current)return;
    reSavingRef.current=true;
    setSaving(true);
    try{
      // Always use fresh date (not stale closure if app was open overnight)
      const saveDate=reportDate||new Date().toLocaleDateString("en-CA",{timeZone:tz});
      // Limit photo data in save payload to prevent oversized JSON / frozen UI
      // Keep only src + name (strip any extra metadata), and cap at 20 photos
      const safePhotos=photos.slice(0,20).map(p=>({id:p.id,src:p.src,name:p.name}));
      const content={vals,lockVals,photos:safePhotos,photoLayout,lockFields,editFields,sigTimestamps,...(isAnyTYR?{contractors:selectedContractors}:{})};
      let contentStr;
      try{contentStr=JSON.stringify(content);}catch(e){
        console.error("JSON serialize failed:",e);
        throw new Error("Failed to save — too much data. Try removing some photos.");
      }
      // Warn if payload is very large (>4MB) — likely to fail or hang
      if(contentStr.length>4*1024*1024){
        console.warn("[saveWorking] Content payload very large:",Math.round(contentStr.length/1024),"KB");
      }
      const savePromise=db.saveReport({
        job_id:job.id,
        user_id:user.id,
        report_date:saveDate,
        status:reportStatus||"working_copy",
        content:contentStr,
        updated_at:new Date().toISOString()
      });
      const timeout=new Promise((_,rej)=>setTimeout(()=>rej(new Error("Save timed out")),15000));
      await Promise.race([savePromise,timeout]);
    }catch(e){
      console.error("Save error:",e);
      showToast("Save failed — check connection");
    }finally{reSavingRef.current=false;setSaving(false);}
  };

  // Safety valve: if saving state gets stuck for >20s, force-reset it
  useEffect(()=>{
    if(!saving)return;
    const t=setTimeout(()=>{reSavingRef.current=false;setSaving(false);console.warn("Force-reset stuck saving state");},20000);
    return()=>clearTimeout(t);
  },[saving]);

  const [submitting,setSubmitting]=useState(false);
  const [submitStep,setSubmitStep]=useState("");
  const [viewLoading,setViewLoading]=useState(false);
  const busyRef=useRef(false); // prevent View+Submit overlap

  // Safety valve: if submitting state gets stuck for >45s, force-reset it
  useEffect(()=>{
    if(!submitting)return;
    const t=setTimeout(()=>{busyRef.current=false;setSubmitting(false);console.warn("Force-reset stuck submitting state");showToast("Submit timed out — please try again");},45000);
    return()=>clearTimeout(t);
  },[submitting]);
  // Safety valve: if viewLoading gets stuck for >30s, force-reset it
  useEffect(()=>{
    if(!viewLoading)return;
    const t=setTimeout(()=>{busyRef.current=false;setViewLoading(false);console.warn("Force-reset stuck viewLoading state");showToast("Preview timed out — please try again");},30000);
    return()=>clearTimeout(t);
  },[viewLoading]);
  const [viewingReport,setViewingReport]=useState(null); // array of page image data URLs
  const [viewDocxHtml,setViewDocxHtml]=useState(null); // HTML string for DOCX preview
  const [editablePreview,setEditablePreview]=useState(null); // {pages:[{imgUrl,w,h}],fields:[...]} for desktop interactive edit
  const [submitSuccess,setSubmitSuccess]=useState(null); // {pdfBlob, pdfFilename, teamEmails} after submit
  const [toast,setToast]=useState("");

  const showToast=(msg)=>{setToast(msg);setTimeout(()=>setToast(""),2500);};

  // Shared: build all field values — editable fields from vals, locked fields from lockVals
  const buildEditableFields=()=>[
    ...editFields.filter(f=>!skippedFields[f.name]).map(f=>({...f,val:vals[f.name]||""})),
    // For AcroForm: include locked fields even without coords (filled by field name)
    ...lockFields.filter(f=>(f.pdfFieldName||f.x!=null)&&(lockVals[f.name]||f.value)).map(f=>({...f,val:lockVals[f.name]||f.value||""}))
  ];

  // Shared: draw fields onto a canvas context (for View Report preview)
  const drawFieldsOnCanvas=(ctx,fields,pageNum,scale,pageH)=>{
    fields.filter(f=>(f.page||1)===pageNum&&f.val&&f.x!=null&&f.y!=null).forEach(f=>{
      const isAutoField=f.autoFill==="date"||f.autoFill==="increment";
      if(!isAutoField&&f.originalValue&&f.val===f.originalValue)return;
      const sz=(f.fontSize||10)*scale;
      ctx.font=sz+"px Georgia, Cambria, serif";
      const drawX=f.x*scale;
      const drawY=f.y*scale+sz;
      // Signature stamp — "Signed by Name on Day, Date at Time — powered by My Daily Reports"
      // Positioned ABOVE the signature line (line is at bottom of field)
      const isSig=(f.name||"").toLowerCase().includes("signature")||(f.autoFill==="name"&&(f.name||"").toLowerCase().includes("inspector"));
      if(isSig){
        const sigSz=sz*0.85;
        const sigTime=sigTimestamps[f.name]?new Date(sigTimestamps[f.name]):new Date();
        const dayName=sigTime.toLocaleDateString("en-US",{weekday:"long"});
        const datePart=sigTime.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
        const timePart=sigTime.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true});
        // Shift up: drawY normally is at bottom of field, move up so sig block sits above the line
        const sigDrawY=f.y*scale-sigSz*0.5;
        ctx.font="italic "+sigSz+"px Georgia, Cambria, serif";
        ctx.fillStyle="#1a1a1a";
        ctx.fillText("Signed by "+f.val,drawX,sigDrawY);
        ctx.font=(sigSz*0.65)+"px Georgia, Cambria, serif";
        ctx.fillStyle="#666666";
        ctx.fillText(dayName+", "+datePart+" at "+timePart,drawX,sigDrawY+sigSz*1.15);
        ctx.font="italic "+(sigSz*0.55)+"px Georgia, Cambria, serif";
        ctx.fillStyle="#999999";
        ctx.fillText("powered by My Daily Reports",drawX,sigDrawY+sigSz*2.1);
        return;
      }
      ctx.fillStyle="#000000";
      if(f.multiline&&f.w){
        const leftPad=6*scale;
        const maxW=f.w*scale-leftPad-4*scale;
        const bullet="\u2022  ";
        const bulletW=ctx.measureText(bullet).width;
        // Split on newlines first, then word-wrap each line with hanging indent
        const rawLines=f.val.split(/\n/).filter(l=>l.trim());
        const useBullets=rawLines.length>1;
        const textAfterBullet=leftPad+bulletW;
        const wrapMaxW=maxW-bulletW;
        const lines=[]; // {text, xOff, newBullet}
        rawLines.forEach(rl=>{
          const clean=rl.replace(/^[\-\•\*]\s*/,"").trim();
          if(!clean)return;
          const words=clean.split(" ");let cur="";let first=true;
          words.forEach(w=>{const test=cur?cur+" "+w:w;if(ctx.measureText(test).width>wrapMaxW&&cur){lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});first=false;cur=w;}else cur=test;});
          if(cur)lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});
        });
        let yOff=0;lines.forEach((ln,li)=>{if(li>0)yOff+=(ln.newBullet&&useBullets)?sz*2:sz*1.5;ctx.fillText(ln.text,drawX+ln.xOff,drawY+yOff);});
      }else{
        ctx.fillText(String(f.val),drawX,drawY);
      }
    });
  };

  // ── Enhanced TYR (V5): Draw ALL fields on canvas preview at hardcoded positions ──
  const drawTyrFieldsOnCanvas=(ctx,fields,scale)=>{
    const v2={};fields.forEach(f=>{if(f.val)v2[(f.name||"").toLowerCase().trim()]=f.val;});
    const wordMatch2=(fn,kw)=>{const re=new RegExp("(^|[\\s_\\-\\.:#])"+kw.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i");return re.test(fn);};
    const fv=(...keys)=>{for(const k of keys){for(const[fn,val]of Object.entries(v2)){if(wordMatch2(fn,k))return val;}}return"";};
    const fv2=(a,b)=>{for(const[fn,val]of Object.entries(v2)){if(wordMatch2(fn,a)&&wordMatch2(fn,b))return val;}return"";};
    const sz=10*scale;const szSm=9*scale;const rh=14.8;
    ctx.fillStyle="#000000";
    // Helper: draw single-line cell with auto-shrink
    const cell=(text,x,topY,w,h,useSz,bold)=>{
      if(!text)return;const s=String(text);const fSz=useSz||sz;
      ctx.font=(bold?"bold ":"")+fSz+"px Helvetica, Arial, sans-serif";
      let tw=ctx.measureText(s).width;let drawSz=fSz;
      if(w&&tw>w-6){drawSz=Math.max(6*scale,fSz*(w-6*scale)/tw);ctx.font=(bold?"bold ":"")+drawSz+"px Helvetica, Arial, sans-serif";}
      const textY=topY*scale+(h*scale+drawSz)/2-drawSz*0.15;
      ctx.fillText(s,(x+3)*scale,textY);
    };
    // Helper: draw multiline wrapped text on canvas
    const multi=(text,x,topY,w,bottomY,useSz)=>{
      if(!text)return;const fSz=useSz||sz;
      ctx.font=fSz+"px Helvetica, Arial, sans-serif";
      const leftPad=6*scale;const maxW=w*scale-leftPad-4*scale;
      const textStartY=topY*scale+fSz;
      const bottomPx=bottomY*scale;
      const rawLines=text.split(/\n/).filter(l=>l.trim());
      const useBullets=rawLines.length>1;
      const bullet="\u2022  ";const bulletW=useBullets?ctx.measureText(bullet).width:0;
      const lines=[];
      rawLines.forEach(rl=>{
        const clean=rl.replace(/^[\-\•\*]\s*/,"").trim();if(!clean)return;
        const words=clean.split(" ");let cur="";let first=true;
        words.forEach(wd=>{const test=cur?cur+" "+wd:wd;if(ctx.measureText(test).width>(maxW-bulletW)&&cur){lines.push({text:first&&useBullets?bullet+cur:cur,xOff:first?leftPad:leftPad+bulletW,newBullet:first});first=false;cur=wd;}else cur=test;});
        if(cur)lines.push({text:first&&useBullets?bullet+cur:cur,xOff:first?leftPad:leftPad+bulletW,newBullet:first});
      });
      // 1.3 line spacing within a bullet, double space (fSz*2) between bullets
      let yOff=0;lines.forEach((ln,i)=>{
        if(i>0)yOff+=(ln.newBullet&&useBullets)?fSz*2.6:fSz*1.3;
        const ly=textStartY+yOff;if(ly<bottomPx)ctx.fillText(ln.text,x*scale+ln.xOff,ly);
      });
    };
    // Header fields (bold)
    cell(fv("district"),109.3,125.2,190.6,rh,sz,true);
    cell(fv2("project","name"),424.4,125.2,164.1,rh,sz,true);
    cell(fv("address"),109.3,142.2,479.2,rh,sz,true);
    cell(fv("dsa"),109.3,159.3,190.6,rh,sz,true);
    cell(fv("tyr project","project #","project#"),424.4,159.3,164.1,rh,sz,true);
    cell(fv("date"),109.3,176.4,190.6,rh,sz,true);
    cell(fv("weather"),424.4,176.4,164.1,rh,szSm,true);
    cell(fv("reg"),109.3,193.4,100.5,rh,sz,false);
    cell(fv("ot"),316.4,193.4,96.6,rh,sz,false);
    cell(fv("dt"),523.5,193.4,65.0,rh,sz,false);
    // General — wraps within box
    multi(fv("general"),70,231.1,517.2,257,sz);
    // Daily Activities — wraps within 80pt box
    multi(fv("activit"),25.2,357.4,562.0,437,sz);
    // Inspection Requests — wraps
    multi(fv("inspection","request","site visit"),195,439.6,392.2,455,szSm);
    // Notes and Comments — removed from TYR output
    // RFI column
    const rfiVal=fv("rfi","ccd","asi","submittal");
    if(rfiVal){
      const rfiX=420*scale;const rowTops=[276.2,293.2,310.3,327.3];
      const parts=rfiVal.split("/").map(s=>s.trim()).filter(Boolean);
      ctx.font=szSm+"px Helvetica, Arial, sans-serif";
      parts.forEach((part,i)=>{if(i<rowTops.length)ctx.fillText(part,rfiX,rowTops[i]*scale+szSm+2*scale);});
    }
  };

  // ── TYR Original: Draw ALL fields on canvas at hardcoded positions (original template layout) ──
  const drawTyrOriginalFieldsOnCanvas=(ctx,fields,scale)=>{
    const v2={};fields.forEach(f=>{if(f.val)v2[(f.name||"").toLowerCase().trim()]=f.val;});
    const wordMatch2=(fn,kw)=>{const re=new RegExp("(^|[\\s_\\-\\.:#])"+kw.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i");return re.test(fn);};
    const fv=(...keys)=>{for(const k of keys){for(const[fn,val]of Object.entries(v2)){if(wordMatch2(fn,k))return val;}}return"";};
    const fv2=(a,b)=>{for(const[fn,val]of Object.entries(v2)){if(wordMatch2(fn,a)&&wordMatch2(fn,b))return val;}return"";};
    const sz=10*scale;const szSm=9*scale;const rh=14.8;
    ctx.fillStyle="#000000";
    // Helper: draw single-line cell with auto-shrink
    const cell=(text,x,topY,w,h,useSz,bold)=>{
      if(!text)return;const s=String(text);const fSz=useSz||sz;
      ctx.font=(bold?"bold ":"")+fSz+"px Helvetica, Arial, sans-serif";
      let tw=ctx.measureText(s).width;let drawSz=fSz;
      if(w&&tw>w-6){drawSz=Math.max(6*scale,fSz*(w-6*scale)/tw);ctx.font=(bold?"bold ":"")+drawSz+"px Helvetica, Arial, sans-serif";}
      const textY=topY*scale+(h*scale+drawSz)/2-drawSz*0.15;
      ctx.fillText(s,(x+3)*scale,textY);
    };
    // Helper: draw multiline wrapped text on canvas
    const multi=(text,x,topY,w,bottomY,useSz)=>{
      if(!text)return;const fSz=useSz||sz;
      ctx.font=fSz+"px Helvetica, Arial, sans-serif";
      const leftPad=6*scale;const maxW=w*scale-leftPad-4*scale;
      const textStartY=topY*scale+fSz;
      const bottomPx=bottomY*scale;
      const rawLines=text.split(/\n/).filter(l=>l.trim());
      const useBullets=rawLines.length>1;
      const bullet="\u2022  ";const bulletW=useBullets?ctx.measureText(bullet).width:0;
      const lines=[];
      rawLines.forEach(rl=>{
        const clean=rl.replace(/^[\-\•\*]\s*/,"").trim();if(!clean)return;
        const words=clean.split(" ");let cur="";let first=true;
        words.forEach(wd=>{const test=cur?cur+" "+wd:wd;if(ctx.measureText(test).width>(maxW-bulletW)&&cur){lines.push({text:first&&useBullets?bullet+cur:cur,xOff:first?leftPad:leftPad+bulletW,newBullet:first});first=false;cur=wd;}else cur=test;});
        if(cur)lines.push({text:first&&useBullets?bullet+cur:cur,xOff:first?leftPad:leftPad+bulletW,newBullet:first});
      });
      let yOff=0;lines.forEach((ln,i)=>{
        if(i>0)yOff+=(ln.newBullet&&useBullets)?fSz*2.6:fSz*1.3;
        const ly=textStartY+yOff;if(ly<bottomPx)ctx.fillText(ln.text,x*scale+ln.xOff,ly);
      });
    };
    // ── Header fields (bold) — original template positions ──
    cell(fv("district"),109.3,127.5,190.6,rh,sz,true);
    cell(fv2("project","name"),424.4,127.5,164.1,rh,sz,true);
    // Address — merged cell spanning full width, taller row (h=27.5)
    cell(fv("address"),109.3,144.5,474.2,27.5,sz,true);
    cell(fv("dsa"),109.3,174.2,190.6,rh,sz,true);
    cell(fv("tyr project","project #","project#"),424.4,174.2,164.1,rh,sz,true);
    cell(fv("date"),109.3,191.2,190.6,rh,sz,true);
    cell(fv("weather"),424.4,191.2,164.1,rh,szSm,true);
    // Hours row (not bold, taller row h=27.5 but draw in first sub-row)
    cell(fv("reg"),109.3,208.2,100.5,rh,sz,false);
    cell(fv("ot"),316.4,208.2,96.6,rh,sz,false);
    cell(fv("dt"),523.5,208.2,65.0,rh,sz,false);
    // ── General (cream box) ──
    multi(fv("general"),25.2,258.4,562.0,286.4,sz);
    // ── Daily Activities (cream content box below label row) ──
    multi(fv("activit"),25.2,369.9,562.0,429.9,sz);
    // ── Single-line bottom fields ──
    cell(fv("inspection","request"),135,432.1,452,rh,szSm,false);
    cell(fv("rfi"),55,449.2,245,rh,szSm,false);
    cell(fv("submittal"),370,449.2,217,rh,szSm,false);
    cell(fv("ccd"),55,466.2,245,rh,szSm,false);
    cell(fv("asi"),345,466.2,242,rh,szSm,false);
    cell(fv("site visit"),80,483.3,507,rh,szSm,false);
    cell(fv("note","comment"),140,500.3,447,rh,szSm,false);
    // ── Signature at bottom ──
    const sigEnabled=job.field_config?.digitalSignature!==false;
    const sigVal=fv("signature","inspector")||user?.user_metadata?.full_name||user?.email?.split("@")[0]||"";
    if(sigEnabled&&sigVal){
      ctx.font=(8*scale)+"px Helvetica, Arial, sans-serif";
      ctx.fillStyle="#1a1a1a";
      ctx.fillText("Signed by "+sigVal,25*scale,575*scale);
      ctx.font=(5.5*scale)+"px Helvetica, Arial, sans-serif";
      ctx.fillStyle="#666666";
      ctx.fillText("powered by My Daily Reports",25*scale,583*scale);
      ctx.fillStyle="#000000";
    }
  };

  // ── TYR Original: Draw contractor table on canvas — 4-column grid ──
  const drawTyrOriginalContractorOnCanvas=(ctx,scale)=>{
    if(selectedContractors.length===0)return;
    const sz=9*scale;
    // 4-column layout: Name | Manpower | Equipment | Trade
    const colX=[25.2,181.2,334.0,471.6];
    const colW=[156,153,138,119]; // approximate widths between dividers
    // 3 data rows
    const rowTops=[305.7,322.8,339.8];
    ctx.fillStyle="#000000";
    ctx.font=sz+"px Helvetica, Arial, sans-serif";
    selectedContractors.forEach((c,i)=>{
      if(i>=rowTops.length)return;
      const textY=rowTops[i]*scale+sz+2*scale;
      // Name
      const name=c.company_name||"";
      let nameSz=sz;
      if(ctx.measureText(name).width>colW[0]*scale-6){nameSz=Math.max(5*scale,sz*(colW[0]*scale-6)/ctx.measureText(name).width);ctx.font=nameSz+"px Helvetica, Arial, sans-serif";}
      ctx.fillText(name,(colX[0]+3)*scale,textY);
      ctx.font=sz+"px Helvetica, Arial, sans-serif";
      // MP
      ctx.fillText(String(c.manpower||0),(colX[1]+3)*scale,textY);
      // Equipment
      ctx.fillText(c.equipment||"",(colX[2]+3)*scale,textY);
      // Trade
      ctx.fillText(c.trade||"",(colX[3]+3)*scale,textY);
    });
  };

  // ── Enhanced TYR (V5): Draw contractor table on canvas preview — exact template coordinates ──
  const drawContractorTableOnCanvas=(ctx,scale,pageH)=>{
    if(selectedContractors.length===0)return;
    const sz=10*scale;
    // Template grey box columns (pdfplumber top-left coords, scaled)
    const leftNameX=25.2*scale;
    const leftMpX=189*scale;
    const rightNameX=229*scale;
    const rightMpX=379*scale;
    // Data row tops (pdfplumber y coords): 276.2, 293.2, 310.3, 327.3
    const rowTops=[276.2,293.2,310.3,327.3];
    const rowH=14.8*scale;
    // Split contractors: first 4 left, next 4 right
    const leftCs=selectedContractors.slice(0,4);
    const rightCs=selectedContractors.slice(4,8);
    ctx.fillStyle="#000000";
    ctx.font="bold "+sz+"px Georgia, Cambria, serif";
    leftCs.forEach((c,i)=>{
      if(i>=rowTops.length)return;
      const textY=rowTops[i]*scale+sz+2*scale;
      ctx.fillText(c.company_name||"",leftNameX,textY);
      ctx.fillText(String(c.manpower||0),leftMpX,textY);
    });
    rightCs.forEach((c,i)=>{
      if(i>=rowTops.length)return;
      const textY=rowTops[i]*scale+sz+2*scale;
      ctx.fillText(c.company_name||"",rightNameX,textY);
      ctx.fillText(String(c.manpower||0),rightMpX,textY);
    });
  };

  // View Report — renders original template with pdf.js, overlays field values + notes on canvas
  const viewReport=async()=>{
    if(busyRef.current)return;
    busyRef.current=true;
    setViewLoading(true);
    try{
      // From-scratch generators don't need a template — generate PDF directly for preview
      if(isFromScratch){
        const allFields=buildEditableFields();
        const genPhotos=[];
        for(const p of photos){
          const src=p.src||p;
          if(typeof src==='string'&&src.startsWith('data:')){
            try{const b64=src.split(',')[1];const bin=atob(b64);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);genPhotos.push({imageBytes:bytes,caption:p.caption||p.name||''});}catch(e){console.warn("Photo convert:",e);}
          }
        }
        let genLogo=null;
        try{
          const cName=isTYR?'TYR Engineering':'VIS - Vital Inspection Services';
          genLogo=await db.downloadTemplateBytes(`${cName}/logo.png`);
        }catch(e){console.warn("Logo fetch:",e);}
        let genSig=null;
        try{
          const prof=await db.getProfile(user.id);
          if(prof?.signature_path){
            const sigUrl=prof.signature_path.startsWith('http')?prof.signature_path:`${SB_URL}/storage/v1/object/public/${prof.signature_path}`;
            const sigR=await fetch(sigUrl);if(sigR.ok)genSig=new Uint8Array(await sigR.arrayBuffer());
          }
        }catch(e){console.warn("Sig fetch:",e);}
        const genDate=new Date((reportDate||todayISO)+"T12:00:00").toLocaleDateString("en-US",{timeZone:tz});
        const genProfile={full_name:user?.user_metadata?.full_name||user?.email?.split("@")[0]||"",certification_number:""};
        const rd={vals:{},photos:genPhotos,...(isTYR?{contractors:selectedContractors}:{})};
        allFields.forEach(f=>{if(f.val)rd.vals[f.name]=f.val;});
        const pdfBytes=isTYR?await generateTYR(rd,job,genProfile,genLogo,genSig,genDate):await generateVIS(rd,job,genProfile,genLogo,genSig,genDate);
        // Render with pdf.js for canvas preview
        const pdfjsLib=await ensurePdfJs();
        const pdfDoc=await pdfjsLib.getDocument({data:pdfBytes}).promise;
        const pages=[];
        for(let i=1;i<=pdfDoc.numPages;i++){
          const pg=await pdfDoc.getPage(i);
          const vp=pg.getViewport({scale:2});
          const cvs=document.createElement("canvas");cvs.width=vp.width;cvs.height=vp.height;
          await pg.render({canvasContext:cvs.getContext("2d"),viewport:vp}).promise;
          pages.push(cvs.toDataURL("image/png",0.92));
        }
        setViewingReport(pages);
        return;
      }
      const tplRecord=await db.getTemplate(job.id);
      // No template at all — show error with diagnostic context
      if(!tplRecord){
        console.error("getTemplate returned null for job:",job.id,job.name);
        throw new Error("No template record found for this job. Go to Job Settings and re-upload your template.");
      }
      if(!tplRecord.storage_path){
        console.error("Template record has no storage_path:",JSON.stringify(tplRecord));
        throw new Error("Template record exists but file is missing. Go to Job Settings and re-upload your template.");
      }
      // DOCX template — call generate-docx to fill it, then render with mammoth
      const isDocx=tplRecord.file_type&&tplRecord.file_type!=="pdf";
      if(isDocx){
        const allFields=buildEditableFields();
        const fieldValues={};
        allFields.forEach(f=>{if(f.val)fieldValues[f.name]=f.val;});
        // Download template (cached)
        const rawTplBytes=await db.downloadTemplateBytes(tplRecord.storage_path);
        if(!rawTplBytes||rawTplBytes.byteLength===0)throw new Error("Template download failed — re-upload in Job Settings.");
        const tplBytes=new Uint8Array(rawTplBytes);
        const tplChunks=[];for(let i=0;i<tplBytes.length;i+=8192)tplChunks.push(String.fromCharCode.apply(null,tplBytes.subarray(i,i+8192)));
        const tplB64=btoa(tplChunks.join(""));
        // Call generate-docx to fill template with field values
        const genResp=await api.generateDocx({docx_base64:tplB64,field_values:fieldValues});
        const genData=await genResp.json();
        if(genData.error)throw new Error(genData.error);
        // Decode filled DOCX and render with mammoth for preview
        const filledBytes=Uint8Array.from(atob(genData.docx_base64),c=>c.charCodeAt(0));
        await ensureMammoth();
        if(window.mammoth){
          const result=await window.mammoth.convertToHtml({arrayBuffer:filledBytes.buffer});
          setViewDocxHtml(result.value);
          setViewingReport(["__docx_html__"]);
        }else{
          throw new Error("Document preview library not loaded. Please reload the app.");
        }
        return;
      }
      const tplBytes=await db.downloadTemplateBytes(tplRecord.storage_path);
      if(!tplBytes||tplBytes.byteLength===0)throw new Error("Template download failed — re-upload in Job Settings.");
      // Validate PDF magic bytes
      const header=new Uint8Array(tplBytes.slice(0,5));
      const headerStr=String.fromCharCode(...header);
      if(!headerStr.startsWith("%PDF")){
        throw new Error("Template file is not a valid PDF. Please re-upload a PDF template.");
      }
      await ensurePdfJs();
      if(!window.pdfjsLib)throw new Error("PDF viewer not loaded.");
      const allFields=buildEditableFields();
      // Company ID determines which template rendering path to use — no filename sniffing needed
      const pjDoc=await window.pdfjsLib.getDocument({data:tplBytes}).promise;
      const previewPages=[];
      const scale=2;
      const isDesktop=window.innerWidth>=768;
      const cleanPages=[];// for desktop editable preview
      for(let pi=1;pi<=pjDoc.numPages;pi++){
        const pg=await pjDoc.getPage(pi);
        const vp=pg.getViewport({scale});
        const vp1=pg.getViewport({scale:1});
        const cvs=document.createElement("canvas");cvs.width=vp.width;cvs.height=vp.height;
        const ctx=cvs.getContext("2d");
        await pg.render({canvasContext:ctx,viewport:vp}).promise;
        if(isDesktop){
          // Store clean page (no overlays) for editable preview
          cleanPages.push({imgUrl:cvs.toDataURL("image/jpeg",0.92),w:vp1.width,h:vp1.height});
        }
        // Draw field values on this page (flat preview)
        const pageH=vp1.height;
        if(isEnhancedTYR&&pi===1){
          // Enhanced TYR (V5): hardcoded positions
          drawTyrFieldsOnCanvas(ctx,allFields,scale);
          drawContractorTableOnCanvas(ctx,scale,pageH);
        }else if(isTYR&&pi===1){
          // Original TYR: separate hardcoded positions
          drawTyrOriginalFieldsOnCanvas(ctx,allFields,scale);
          drawTyrOriginalContractorOnCanvas(ctx,scale);
        }else{
          drawFieldsOnCanvas(ctx,allFields,pi,scale,pageH);
        }
        previewPages.push(cvs.toDataURL("image/jpeg",0.92));
        cvs.width=0;cvs.height=0;
      }
      // TYR templates: flat rendered preview (hardcoded positions match PDF exactly)
      // All other templates: editable preview with field overlays
      if(isAnyTYR){
        setEditablePreview(null);
      }else if(isDesktop&&cleanPages.length>0){
        const posFields=allFields.filter(f=>f.x!=null&&f.y!=null);
        setEditablePreview({pages:cleanPages,fields:posFields});
      }
      // Render photos as additional preview pages — paginate to match PDF output
      if(photos.length>0){
        const perPage=photoLayout==="1"?1:photoLayout==="2"?2:4;
        const pgW=612*scale;const pgH=792*scale;
        const bodyW=(612-72)*scale;
        const usableHP=pgH-80*scale;
        // Pre-load all images — draw to temp canvas to get EXIF-corrected dimensions
        const loaded=[];
        for(let i=0;i<photos.length;i++){
          try{
            const src=photos[i].src||photos[i];
            const im=new Image();
            await Promise.race([
              new Promise((res,rej)=>{im.onload=res;im.onerror=rej;im.src=src;}),
              new Promise((_,rej)=>setTimeout(()=>rej(new Error("Image load timeout")),10000))
            ]);
            // Draw to 1x1 canvas to force EXIF rotation, then read rendered size
            // createImageBitmap respects EXIF and gives us the real dimensions
            let w=im.naturalWidth,h=im.naturalHeight;
            try{const bmp=await createImageBitmap(im);w=bmp.width;h=bmp.height;bmp.close();}catch(e){}
            loaded.push({im,ratio:w/h,isLandscape:w>=h,corrW:w,corrH:h});
          }catch(e){loaded.push(null);}
        }
        const validPhotos=loaded.filter(Boolean);
        const attachLabelHP=16*scale; // "ATTACHMENT" label height in preview
        const newPhotoPage=()=>{
          const cvs=document.createElement("canvas");cvs.width=pgW;cvs.height=pgH;
          const ctx=cvs.getContext("2d");
          ctx.fillStyle="#ffffff";ctx.fillRect(0,0,pgW,pgH);
          // "ATTACHMENT" label
          ctx.fillStyle="#000000";ctx.font="bold "+(11*scale)+"px Helvetica, Arial, sans-serif";
          ctx.fillText("ATTACHMENT",36*scale,52*scale);
          return {cvs,ctx};
        };
        // Draw photo inside a bordered box (matches PDF output)
        const drawPhotoInBoxP=(ctx,p,bx,by,bw,bh)=>{
          const {im,ratio,corrW,corrH}=p;
          // Border box
          ctx.strokeStyle="#000000";ctx.lineWidth=1;
          ctx.strokeRect(bx,by,bw,bh);
          ctx.fillStyle="#ffffff";ctx.fillRect(bx+1,by+1,bw-2,bh-2);
          // Fit image inside box with padding
          const pad=8*scale;
          const innerW=bw-pad*2;const innerH=bh-pad*2;
          let imgW,imgH;
          if(ratio>=1){imgW=Math.min(innerW,innerH*ratio);imgH=imgW/ratio;}
          else{imgH=Math.min(innerH,innerW/ratio);imgW=imgH*ratio;}
          const tc=document.createElement("canvas");tc.width=corrW||im.naturalWidth;tc.height=corrH||im.naturalHeight;
          tc.getContext("2d").drawImage(im,0,0,tc.width,tc.height);
          ctx.drawImage(tc,bx+pad+(innerW-imgW)/2,by+pad+(innerH-imgH)/2,imgW,imgH);
          tc.width=0;tc.height=0;
        };
        const boxTopP=60*scale+attachLabelHP;
        const boxAreaHP=usableHP-20*scale-attachLabelHP;
        let idx=0;
        while(idx<validPhotos.length){
          if(photoLayout==="1"){
            const {cvs,ctx}=newPhotoPage();
            drawPhotoInBoxP(ctx,validPhotos[idx],36*scale,boxTopP,bodyW,boxAreaHP);
            previewPages.push(cvs.toDataURL("image/jpeg",0.92));cvs.width=0;cvs.height=0;
            idx++;
          }else if(photoLayout==="2"){
            const pair=[validPhotos[idx]];
            if(idx+1<validPhotos.length)pair.push(validPhotos[idx+1]);
            const {cvs,ctx}=newPhotoPage();
            const gap=10*scale;
            const bh=pair.length===1?boxAreaHP:(boxAreaHP-gap)/2;
            pair.forEach((p,r)=>{
              drawPhotoInBoxP(ctx,p,36*scale,boxTopP+r*(bh+gap),bodyW,bh);
            });
            previewPages.push(cvs.toDataURL("image/jpeg",0.92));cvs.width=0;cvs.height=0;
            idx+=pair.length;
          }else{
            // 4 per page — 2x2 grid
            const chunk=validPhotos.slice(idx,idx+4);
            const {cvs,ctx}=newPhotoPage();
            const gx=10*scale;const gy=10*scale;
            const bw=(bodyW-gx)/2;const bh=(boxAreaHP-gy)/2;
            chunk.forEach((p,ci)=>{
              const col=ci%2;const row=Math.floor(ci/2);
              drawPhotoInBoxP(ctx,p,36*scale+col*(bw+gx),boxTopP+row*(bh+gy),bw,bh);
            });
            previewPages.push(cvs.toDataURL("image/jpeg",0.92));cvs.width=0;cvs.height=0;
            idx+=chunk.length;
          }
        }
      }
      // Clean up pdf.js document to free memory
      if(pjDoc)try{pjDoc.destroy();}catch(e){}
      setViewingReport(previewPages);
    }catch(e){
      console.error("View report error:",e);
      showToast("Error: "+e.message);
    }finally{busyRef.current=false;setViewLoading(false);}
  };

  // Submit Report — generates filled PDF with pdf-lib, uploads, emails, all in one step
  const submitReport=async()=>{
    if(busyRef.current)return;
    busyRef.current=true;
    setSubmitting(true);setSubmitStep("Loading template...");
    // Always use fresh current date at submit time (not stale closure value)
    const submitDate=reportDate||new Date().toLocaleDateString("en-CA",{timeZone:tz});
    try{
      const PDFLib=await ensurePdfLib();
      const {PDFDocument,rgb,StandardFonts}=PDFLib;

      // ── 1b. Build fields + AI proofread (before any path) ──
      const allFields=buildEditableFields();

      // AI Proofreading — only if enabled in job settings
      if(job.field_config?.aiProofread){
        try{
          setSubmitStep("Proofreading...");
          console.log("[submit] AI Proofreading is ON — collecting text fields...");
          const textFields={};
          allFields.forEach(f=>{
            if(f.val&&typeof f.val==="string"&&f.val.trim().length>10){
              const ln=f.name.toLowerCase();
              // WHITELIST: only proofread the free-text note fields where inspectors dictate
              if(/general|activit|inspection.*request|site.?visit|note|comment|observation|description|remark/i.test(ln))
                textFields[f.name]=f.val;
            }
          });
          console.log("[submit] Sending",Object.keys(textFields).length,"fields to proofread:",Object.keys(textFields));
          if(Object.keys(textFields).length>0){
            const proofData=await api.proofreadReport({fields:textFields});
            console.log("[submit] Proofread response:",JSON.stringify(proofData));
            if(proofData?.corrected&&Object.keys(proofData.corrected).length>0){
              console.log("[submit] Applying",Object.keys(proofData.corrected).length,"corrections");
              allFields.forEach(f=>{if(proofData.corrected[f.name])f.val=proofData.corrected[f.name];});
            }else{
              console.log("[submit] No corrections needed");
            }
          }
        }catch(proofErr){
          console.error("[submit] Proofread FAILED:",proofErr.message,proofErr);
          // Non-blocking — report still submits with original text
        }
      }else{
        console.log("[submit] AI Proofreading is OFF for this job");
      }

      // ── FROM-SCRATCH generators (original TYR, VIS) ──
      if(isFromScratch){
        setSubmitStep("Generating report...");
        // Convert photo dataUrls → imageBytes for generator
        const genPhotos=[];
        for(const p of photos){
          const src=p.src||p;
          if(typeof src==='string'&&src.startsWith('data:')){
            try{const b64=src.split(',')[1];const bin=atob(b64);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);genPhotos.push({imageBytes:bytes,caption:p.caption||p.name||''});}catch(e){console.warn("Photo convert:",e);}
          }
        }
        // Fetch logo from company-templates storage
        let genLogo=null;
        try{
          const cName=isTYR?'TYR Engineering':'VIS - Vital Inspection Services';
          genLogo=await db.downloadTemplateBytes(`${cName}/logo.png`);
        }catch(e){console.warn("Logo fetch:",e);}
        // Fetch signature bytes
        let genSig=null;
        try{
          const prof=await db.getProfile(user.id);
          if(prof?.signature_path){
            const sigUrl=prof.signature_path.startsWith('http')?prof.signature_path:`${SB_URL}/storage/v1/object/public/${prof.signature_path}`;
            const sigR=await fetch(sigUrl);if(sigR.ok)genSig=new Uint8Array(await sigR.arrayBuffer());
          }
        }catch(e){console.warn("Sig fetch:",e);}
        const genDate=new Date(submitDate+"T12:00:00").toLocaleDateString("en-US",{timeZone:tz});
        const genProfile={full_name:user?.user_metadata?.full_name||user?.email?.split("@")[0]||"",certification_number:""};
        let scratchBytes;
        if(isTYR){
          const rd={vals:{},contractors:selectedContractors,photos:genPhotos};
          allFields.forEach(f=>{if(f.val)rd.vals[f.name]=f.val;});
          scratchBytes=await generateTYR(rd,job,genProfile,genLogo,genSig,genDate);
        }else{
          const rd={vals:{},photos:genPhotos};
          allFields.forEach(f=>{if(f.val)rd.vals[f.name]=f.val;});
          scratchBytes=await generateVIS(rd,job,genProfile,genLogo,genSig,genDate);
        }
        // Build blob + base64
        const pdfBlob=new Blob([scratchBytes],{type:"application/pdf"});
        const uint8=new Uint8Array(scratchBytes);const chunks=[];for(let i=0;i<uint8.length;i+=8192)chunks.push(String.fromCharCode.apply(null,uint8.subarray(i,i+8192)));
        const pdfBase64=btoa(chunks.join(""));
        // Build filename
        let rptNumber=1;
        try{const cntR=await fetch(`${SB_URL}/rest/v1/reports?select=report_number&job_id=eq.${job.id}&order=report_number.desc&limit=1`,{headers:db._h()});const topR=cntR.ok?await cntR.json():[];if(topR[0]?.report_number)rptNumber=topR[0].report_number+1;}catch(e){}
        if(draftId){try{const exR=await fetch(`${SB_URL}/rest/v1/reports?select=report_number,report_date&id=eq.${draftId}`,{headers:db._h()});const exD=exR.ok?await exR.json():[];if(exD[0]?.report_number&&exD[0]?.report_date===submitDate)rptNumber=exD[0].report_number;}catch(e){}}
        const conv=job.field_config?.filenameConvention||{};
        const padding=conv.numberPadding||0;
        const rptNum=padding>0?String(rptNumber).padStart(padding,"0"):String(rptNumber);
        const now=new Date(submitDate+"T12:00:00");
        const fmtMM=now.toLocaleDateString("en-US",{month:"2-digit",timeZone:tz});
        const fmtDD=now.toLocaleDateString("en-US",{day:"2-digit",timeZone:tz});
        const fmtYYYY=now.toLocaleDateString("en-US",{year:"numeric",timeZone:tz});
        const monNames=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const monthIdx=now.toLocaleDateString("en-US",{month:"numeric",timeZone:tz})-1;
        const fmtMon=monNames[monthIdx]||"";const fmtDay=String(parseInt(fmtDD));
        let baseName;
        if(filenameEdited&&editFilename.trim()){baseName=editFilename.trim().replace(/\.pdf$/i,"");}
        else{
          const pattern=conv.pattern||job.report_filename_pattern||job.name||"Report";
          baseName=pattern.replace(/\.[^.]+$/,"").replace(/\{report_number\}/g,rptNum).replace(/\{date\}/g,now.toLocaleDateString("en-US",{timeZone:tz})).replace(/\{year\}/g,fmtYYYY).replace(/\{project\}/g,(job.name||"").replace(/\s+/g,"_"));
          if(!baseName.includes(rptNum))baseName=rptNum+"_"+baseName;
          const litDateRx=/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s_]+\d{1,2}[,\s_]+\d{4}/;
          if(litDateRx.test(baseName))baseName=baseName.replace(litDateRx,fmtMon+" "+fmtDay+"_"+fmtYYYY);
          else if(!/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(baseName))baseName+="_"+fmtMon+" "+fmtDay+"_"+fmtYYYY;
        }
        const pdfFilename=baseName+".pdf";
        // Upload + save
        setSubmitStep("Uploading report...");
        const storagePath=`${user.id}/${job.id}/reports/${pdfFilename}`;
        await api.uploadStorage(storagePath,pdfBlob,"application/pdf");
        setSubmitStep("Saving report...");
        const reportContent={vals,lockVals,photos,photoLayout,lockFields,editFields,sigTimestamps,...(isAnyTYR?{contractors:selectedContractors}:{})};
        await db.saveReport({job_id:job.id,user_id:user.id,report_date:submitDate,status:"submitted",content:JSON.stringify(reportContent),updated_at:new Date().toISOString()});
        if(isAnyTYR&&selectedContractors.length>0&&draftId)try{await db.saveReportContractors(draftId,job.id,user.id,selectedContractors);}catch(e){console.error("Save report contractors:",e);}
        const userName=user.user_metadata?.full_name||user.email?.split("@")[0]||"Inspector";
        const photoThumbs=photos.length>0?photos.slice(0,6).map(p=>{const src=typeof p==="string"?p:(p.src||p.dataUrl||p.url||"");return src?`<img src="${src}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid #ddd;" alt="Site photo"/>`:"";}).filter(Boolean).join(""):"";
        const photoSection=photoThumbs?`<div style="margin-top:16px;"><p style="color:#888;font-size:12px;margin:0 0 8px;">Site Photos (${photos.length}):</p><div style="display:flex;flex-wrap:wrap;gap:8px;">${photoThumbs}</div></div>`:"";
        const emailHtml=`<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;"><div style="background:#e8742a;padding:20px 24px;border-radius:8px 8px 0 0;"><h1 style="color:#fff;margin:0;font-size:20px;">My Daily Reports</h1></div><div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;"><p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 8px;">Hi,</p><p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 16px;">${userName} has submitted the daily field report for <strong>${job.name}</strong> on ${todayDisplay}.</p><p style="color:#555;font-size:14px;margin:0;">The full PDF report is attached to this email.</p>${photoSection}</div><p style="color:#999;font-size:11px;text-align:center;margin-top:16px;">Sent via My Daily Reports &bull; mydailyreports.org</p></div>`;
        const rawTeam=job.team_emails||[];const teamEmails=rawTeam.map(m=>typeof m==="string"?m:m.email).filter(Boolean);
        setSubmitSuccess({pdfBlob,pdfFilename,pdfBase64,emailHtml,teamEmails,jobName:job.name,todayDisplay,userName});
        showToast("Report submitted!");
        return; // ← skip standard overlay path
      }

      // ── 1. Look up template (only needed for non-from-scratch paths) ──
      const tplRecord=await db.getTemplate(job.id);
      if(!tplRecord){console.error("Submit: no template record for job:",job.id);throw new Error("No template record found. Go to Job Settings and re-upload your template.");}
      if(!tplRecord.storage_path){console.error("Submit: template has no storage_path:",JSON.stringify(tplRecord));throw new Error("Template file is missing. Go to Job Settings and re-upload your template.");}
      const tplBytes=await db.downloadTemplateBytes(tplRecord.storage_path);
      if(!tplBytes||tplBytes.byteLength===0){throw new Error("Template download failed — file may be missing from storage. Go to Job Settings and re-upload your template.");}
      const isPdfTemplate=tplRecord.file_type==="pdf";
      const isDocxTemplate=tplRecord.file_type==="docx"||tplRecord.file_type==="doc";

      // ── DOCX path: send to edge function for XML editing ──
      setSubmitStep("Generating report...");
      if(isDocxTemplate){
        const fieldValues={};
        allFields.forEach(f=>{if(f.val)fieldValues[f.name]=f.val;});
        // Convert template to base64
        const tplUint8=new Uint8Array(tplBytes);
        const tplChunks=[];for(let i=0;i<tplUint8.length;i+=8192)tplChunks.push(String.fromCharCode.apply(null,tplUint8.subarray(i,i+8192)));
        const tplB64=btoa(tplChunks.join(""));
        // Call generate-docx edge function
        const genResp=await api.generateDocx({docx_base64:tplB64,field_values:fieldValues});
        const genData=await genResp.json();
        if(genData.error)throw new Error(genData.error);
        // Decode the returned filled DOCX
        const filledBytes=Uint8Array.from(atob(genData.docx_base64),c=>c.charCodeAt(0));
        const docxBlob=new Blob([filledBytes],{type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
        const chunks=[];for(let i=0;i<filledBytes.length;i+=8192)chunks.push(String.fromCharCode.apply(null,filledBytes.subarray(i,i+8192)));
        const docxBase64=btoa(chunks.join(""));
        // Build filename (same logic as PDF path)
        let rptNumber=1;
        try{const cntR=await fetch(`${SB_URL}/rest/v1/reports?select=report_number&job_id=eq.${job.id}&order=report_number.desc&limit=1`,{headers:db._h()});const topR=cntR.ok?await cntR.json():[];if(topR[0]?.report_number)rptNumber=topR[0].report_number+1;}catch(e){}
        if(draftId){try{const exR=await fetch(`${SB_URL}/rest/v1/reports?select=report_number,report_date&id=eq.${draftId}`,{headers:db._h()});const exD=exR.ok?await exR.json():[];if(exD[0]?.report_number&&exD[0]?.report_date===submitDate)rptNumber=exD[0].report_number;}catch(e){}}
        const conv=job.field_config?.filenameConvention||{};
        const padding=conv.numberPadding||0;
        const rptNum=padding>0?String(rptNumber).padStart(padding,"0"):String(rptNumber);
        const now=new Date(submitDate+"T12:00:00");
        const fmtMM=now.toLocaleDateString("en-US",{month:"2-digit",timeZone:tz});
        const fmtDD=now.toLocaleDateString("en-US",{day:"2-digit",timeZone:tz});
        const fmtYYYY=now.toLocaleDateString("en-US",{year:"numeric",timeZone:tz});
        const monthNames=["January","February","March","April","May","June","July","August","September","October","November","December"];
        const monNames=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const monthIdx=now.toLocaleDateString("en-US",{month:"numeric",timeZone:tz})-1;
        const fmtMonth=monthNames[monthIdx]||"";const fmtMon=monNames[monthIdx]||"";
        const fmtDay=String(parseInt(fmtDD));
        const formatDate=(fmt)=>{
          if(!fmt)return"";
          if(/MM|DD|YYYY|Month|Mon/.test(fmt))return fmt.replace(/YYYY/g,fmtYYYY).replace(/MM/g,fmtMM).replace(/DD/g,fmtDD).replace(/Month/g,fmtMonth).replace(/Mon/g,fmtMon);
          const f=fmt.trim();
          if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(f))return now.toLocaleDateString("en-US",{timeZone:tz});
          if(/^\d{4}-\d{2}-\d{2}$/.test(f))return now.toLocaleDateString("en-CA",{timeZone:tz});
          if(/^[A-Za-z]{3}\s+\d{1,2},?\s+\d{4}$/.test(f))return now.toLocaleDateString("en-US",{month:"short",day:"2-digit",year:"numeric",timeZone:tz});
          if(/^[A-Za-z]+\s+\d{1,2},?\s+\d{4}$/.test(f))return now.toLocaleDateString("en-US",{month:"long",day:"2-digit",year:"numeric",timeZone:tz});
          if(/^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(f)){const pd=f.startsWith("0");return now.toLocaleDateString("en-US",{day:pd?"2-digit":"numeric",month:"long",year:"numeric",timeZone:tz}).replace(/^(\w+)\s(\d+),\s(\d+)$/,(_,m,d,y)=>`${pd?d.padStart(2,"0"):d} ${m} ${y}`);}
          if(/^[A-Za-z]{3}\s+\d{1,2}$/.test(f))return fmtMon+" "+fmtDD.replace(/^0/,"");
          if(/^\d{2}-\d{2}-\d{4}$/.test(f))return fmtMM+"-"+fmtDD+"-"+fmtYYYY;
          return now.toLocaleDateString("en-US",{timeZone:tz});
        };
        // Build filename — use user-edited filename if they changed it
        let baseName;
        if(filenameEdited&&editFilename.trim()){
          baseName=editFilename.trim().replace(/\.(pdf|docx?)$/i,"");
          try{
            let learned=baseName;
            const dateVariants=[fmtMon+" "+fmtDay+"_"+fmtYYYY,fmtMon+" "+fmtDay+", "+fmtYYYY,fmtMon+" "+fmtDay+" "+fmtYYYY,fmtMM+"/"+fmtDD+"/"+fmtYYYY,fmtMM+"-"+fmtDD+"-"+fmtYYYY,fmtYYYY+"-"+fmtMM+"-"+fmtDD];
            for(const dv of dateVariants){if(learned.includes(dv)){learned=learned.replace(dv,"{date}");break;}}
            if(learned.includes(rptNum))learned=learned.replace(rptNum,"{report_number}");
            const oldPattern=conv.pattern||job.report_filename_pattern||"";
            if(learned!==oldPattern&&learned!==baseName){
              const newConv={...conv,pattern:learned};
              db.updateJobFieldConfig(job.id,{...job.field_config,filenameConvention:newConv}).catch(e=>console.error("Pattern save:",e));
            }
          }catch(learnErr){}
        }else{
          const fnPattern=conv.pattern||job.report_filename_pattern||job.name||"Report";
          baseName=fnPattern.replace(/\.[^.]+$/,"");
          const hasDateToken=baseName.includes("{date}")||baseName.includes("{year}");
          const hasNumToken=baseName.includes("{report_number}");
          baseName=baseName.replace(/\{report_number\}/g,rptNum);
          baseName=baseName.replace(/\{date\}/g,formatDate(conv.dateFormat));
          baseName=baseName.replace(/\{year\}/g,fmtYYYY);
          baseName=baseName.replace(/\{project\}/g,(job.name||"").replace(/\s+/g,"_"));
          if(!hasDateToken){
            const litDateRx=/(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s_]+\d{1,2}[,\s_]+\d{4}/;
            const newDateStr=fmtMon+" "+fmtDay+"_"+fmtYYYY;
            if(litDateRx.test(baseName)){baseName=baseName.replace(litDateRx,newDateStr);}
            else{baseName+="_"+newDateStr;}
          }
          if(!hasNumToken){
            const replaced=baseName.replace(/_(\d+)(?=_)/,()=>"_"+rptNum);
            if(replaced===baseName)baseName=rptNum+"_"+baseName;
            else baseName=replaced;
          }
        }
        const docxFilename=baseName+".docx";
        // Upload file first, THEN save report record (ensures file exists before marking submitted)
        setSubmitStep("Uploading report...");
        const vals={};const lockVals={};
        allFields.forEach(f=>{if(f.autoFill||f.mode==="edit")vals[f.name]=f.val;else lockVals[f.name]=f.val;});
        const storagePath=`${user.id}/${job.id}/reports/${docxFilename}`;
        await api.uploadStorage(storagePath,docxBlob,"application/octet-stream");
        const reportContent={vals,lockVals,photos:[],photoLayout:"1",lockFields:[],editFields:allFields,...(isAnyTYR?{contractors:selectedContractors}:{})};
        await db.saveReport({job_id:job.id,user_id:user.id,report_date:submitDate,status:"submitted",content:JSON.stringify(reportContent),updated_at:new Date().toISOString()});
        if(isAnyTYR&&selectedContractors.length>0&&draftId)try{await db.saveReportContractors(draftId,job.id,user.id,selectedContractors);}catch(e){console.error("Save report contractors:",e);}
        const userName=user.user_metadata?.full_name||user.email?.split("@")[0]||"Inspector";
        const emailHtml=`<div style="font-family:-apple-system,sans-serif;max-width:600px;"><div style="background:#e8742a;padding:20px 24px;border-radius:8px 8px 0 0;"><h1 style="color:#fff;margin:0;font-size:20px;">My Daily Reports</h1></div><div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;"><p style="color:#333;font-size:16px;">${userName} has submitted the daily report for <strong>${job.name}</strong> on ${todayDisplay}.</p><p style="color:#555;font-size:14px;">The filled DOCX report is attached.</p></div></div>`;
        const rawTeam=job.team_emails||[];
        const teamEmails=rawTeam.map(m=>typeof m==="string"?m:m.email).filter(Boolean);
        setSubmitSuccess({pdfBlob:docxBlob,pdfFilename:docxFilename,pdfBase64:docxBase64,emailHtml,teamEmails,jobName:job.name,todayDisplay,userName});
        return;
      }

      // ── 2. Field values (already built + proofread above) ──
      const fcSource=(job.field_config||{}).source;

      // ── 2b. AcroForm fill-by-name path (for fillable PDFs uploaded via AcroForm detection) ──
      let pdfDoc;let srcDoc=null;
      if(isPdfTemplate&&fcSource==="acroform"){
        console.log("[submit] Using AcroForm fill-by-name path");
        pdfDoc=await PDFDocument.load(tplBytes,{ignoreEncryption:true});
        const acroFont=await pdfDoc.embedFont(StandardFonts.TimesRoman);
        const acroFontItalic=await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
        // Strategy: extract widget rectangles from AcroForm fields, remove ALL fields,
        // then drawText directly on the page — no appearance streams, no white boxes.
        const textsToDraw=[];
        try{
          const form=pdfDoc.getForm();
          const pdfPages=pdfDoc.getPages();
          // Build page ref→index map for finding which page a widget belongs to
          const pageRefs=pdfPages.map((p,i)=>({ref:p.ref,idx:i}));
          const getPageIdx=(widget)=>{
            try{const pRef=widget.P();if(pRef){const match=pageRefs.find(pr=>pr.ref===pRef);if(match)return match.idx;}}catch(e){}
            // Fallback: check which page contains this widget annotation
            for(let pi=0;pi<pdfPages.length;pi++){try{const annots=pdfPages[pi].node.Annots();if(annots){const refs=annots.asArray();for(const r of refs){if(r===widget.ref||r.toString()===widget.ref.toString())return pi;}}}catch(e){}}
            return 0;
          };
          const getWidgetRect=(fieldName)=>{
            try{
              const f=form.getTextField(fieldName);
              const widgets=f.acroField.getWidgets();
              if(widgets.length>0){const w=widgets[0];const r=w.getRectangle();return{x:r.x,y:r.y,w:r.width,h:r.height,pageIdx:getPageIdx(w)};}
            }catch(e){}
            return null;
          };

          allFields.forEach(f=>{
            if(!f.val)return;
            const pfn=f.pdfFieldName;
            if(!pfn)return;
            try{
              // Grouped date fields — split value across parts
              if(f.pdfDateParts&&f.pdfDateParts.length>1){
                const dateVal=String(f.val);
                let parts=[];
                const slashMatch=dateVal.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
                const isoMatch=dateVal.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
                const longMatch=dateVal.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
                if(slashMatch)parts=[slashMatch[1],slashMatch[2],slashMatch[3]];
                else if(isoMatch)parts=[isoMatch[2],isoMatch[3],isoMatch[1]];
                else if(longMatch){const mi=["january","february","march","april","may","june","july","august","september","october","november","december"].indexOf(longMatch[1].toLowerCase())+1;parts=[String(mi),longMatch[2],longMatch[3]];}
                else parts=[dateVal];
                f.pdfDateParts.forEach((partName,i)=>{
                  if(!parts[i])return;
                  const rect=getWidgetRect(partName);
                  if(rect)textsToDraw.push({val:parts[i],x:rect.x,y:rect.y,w:rect.w,h:rect.h,pageIdx:rect.pageIdx,fontSize:f.fontSize});
                });
                return;
              }
              if(f.type==="checkbox"){
                // Checkboxes: use form API then flatten individually
                try{const cb=form.getCheckBox(pfn);if(f.val==="on"||f.val===true)cb.check();else cb.uncheck();}catch(e){}
                return;
              }
              // Text fields and dropdowns: extract rect, draw text directly
              const rect=getWidgetRect(pfn);
              if(!rect)return;
              const isSig=f.autoFill!=="date"&&f.autoFill!=="increment"&&((f.name||"").toLowerCase().includes("signature")||(f.autoFill==="name"&&(f.name||"").toLowerCase().includes("inspector")));
              textsToDraw.push({val:String(f.val),x:rect.x,y:rect.y,w:rect.w,h:rect.h,pageIdx:rect.pageIdx,fontSize:f.fontSize,isSig,multiline:f.multiline,name:f.name});
            }catch(fieldErr){
              console.warn("[submit] Could not process AcroForm field '"+pfn+"':",fieldErr.message);
            }
          });

          // Remove ALL form fields — no white boxes, no appearance streams
          const allFormFields=form.getFields();
          allFormFields.forEach(field=>{try{form.removeField(field);}catch(e){}});
        }catch(formErr){
          console.error("[submit] AcroForm field extraction failed:",formErr);
        }

        // Draw text directly on pages at the extracted coordinates
        const pdfPages2=pdfDoc.getPages();
        textsToDraw.forEach(td=>{
          const page=pdfPages2[td.pageIdx];
          if(!page)return;
          const sz=td.fontSize||10;
          if(td.isSig){
            // Signature: place above the field area
            const sigSz=sz*0.85;
            const sigY=td.y+td.h-sigSz*0.3;
            const sigTime=sigTimestamps[td.name]?new Date(sigTimestamps[td.name]):new Date();
            const dayName=sigTime.toLocaleDateString("en-US",{weekday:"long"});
            const datePart=sigTime.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
            const timePart=sigTime.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true});
            page.drawText("Signed by "+td.val,{x:td.x+2,y:sigY,size:sigSz,font:acroFontItalic,color:rgb(0.1,0.1,0.1)});
            page.drawText(dayName+", "+datePart+" at "+timePart,{x:td.x+2,y:sigY-sigSz*1.15,size:sigSz*0.65,font:acroFont,color:rgb(0.4,0.4,0.4)});
            page.drawText("powered by My Daily Reports",{x:td.x+2,y:sigY-sigSz*2.1,size:sigSz*0.55,font:acroFontItalic,color:rgb(0.6,0.6,0.6)});
          }else if(td.multiline&&td.w>0){
            // Multiline: bullet-formatted with hanging indent, start text at top of field, wrap within width
            const leftPad=6;
            const textStartY=td.y+td.h-sz;
            const rawLines=td.val.split(/\n/).filter(l=>l.trim());
            const useBullets=rawLines.length>1;
            const bullet="\u2022  ";
            const bulletW=useBullets?acroFont.widthOfTextAtSize(bullet,sz):0;
            const textAfterBullet=leftPad+bulletW;
            const wrapMaxW=td.w-leftPad-4-bulletW;
            const lines=[];
            rawLines.forEach(rl=>{
              const clean=rl.replace(/^[\-\•\*]\s*/,"").trim();
              if(!clean)return;
              const words=clean.split(" ");let cur="";let first=true;
              words.forEach(w=>{const test=cur?cur+" "+w:w;const tw=acroFont.widthOfTextAtSize(test,sz);if(tw>wrapMaxW&&cur){lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});first=false;cur=w;}else cur=test;});
              if(cur)lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});
            });
            let yOff=0;lines.forEach((ln,i)=>{if(i>0)yOff+=(ln.newBullet&&useBullets)?sz*2:sz*1.5;const ly=textStartY-yOff;if(ly>=td.y)page.drawText(ln.text,{x:td.x+ln.xOff,y:ly,size:sz,font:acroFont,color:rgb(0,0,0)});});
          }else{
            // Single line: vertically center text in the field rect, auto-shrink if too wide
            let useSz=sz;
            if(td.w>0){const tw=acroFont.widthOfTextAtSize(td.val,useSz);if(tw>td.w-4){useSz=Math.max(6,useSz*(td.w-4)/tw);}}
            const textY=td.y+(td.h-useSz)/2+useSz*0.15;
            page.drawText(td.val,{x:td.x+2,y:textY,size:useSz,font:acroFont,color:rgb(0,0,0)});
          }
        });
        // Load a separate copy for photo page header/footer embedding
        try{srcDoc=await PDFDocument.load(tplBytes,{ignoreEncryption:true});}catch(e){srcDoc=null;}
      }else{
        // ── 2a. Standard path: copyPages to preserve original visual content ──
        if(isPdfTemplate){
          srcDoc=await PDFDocument.load(tplBytes,{ignoreEncryption:true});
          pdfDoc=await PDFDocument.create();
          const copiedPages=await pdfDoc.copyPages(srcDoc,srcDoc.getPageIndices());
          copiedPages.forEach(p=>pdfDoc.addPage(p));
        }else{
          pdfDoc=await PDFDocument.create();pdfDoc.addPage([612,792]);
        }
      }
      const font=await pdfDoc.embedFont(StandardFonts.TimesRoman);
      const fontBold=await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
      const fontItalic=await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
      const pages=pdfDoc.getPages();

      // ── 3. Fill fields by coordinates ──
      if(fcSource!=="acroform"){
      if(isEnhancedTYR&&pages.length>0){
        // ── Enhanced TYR (V5): Hardcoded field positions from template analysis ──
        // All coordinates in pdfplumber top-left system; convert: pdfY = 792 - top
        const pg1=pages[0];const pgH=pg1.getHeight();
        const sz=10;const szSm=9;
        // TYR uses Helvetica (sans-serif) to better match Century Gothic template style
        const tyrFont=await pdfDoc.embedFont(StandardFonts.Helvetica);
        const tyrFontBold=await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const tyrFontItalic=await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
        // Helper: draw single-line text, vertically centered in cell, auto-shrink
        const drawCell=(text,x,topY,w,h,useSz,useFont)=>{
          if(!text)return;
          const s=String(text);let fs=useSz||sz;const f2=useFont||tyrFont;
          const tw=f2.widthOfTextAtSize(s,fs);
          if(w&&tw>w-6)fs=Math.max(6,fs*(w-6)/tw);
          const pdfY=pgH-topY-(h+fs)/2+fs*0.15;
          pg1.drawText(s,{x:x+3,y:pdfY,size:fs,font:f2,color:rgb(0,0,0)});
        };
        // Helper: draw multiline text with word-wrap inside a box
        // lineSpacing: multiplier for line height (default 1.3 for readability)
        // useFontSz: optional font size override
        // useF: optional font override
        // noBullets: if true, skip bullet formatting even for multi-line text
        const drawMulti=(text,x,topY,w,h,{lineSpacing=1.3,useFontSz,useF,noBullets,bottomLimit}={})=>{
          if(!text)return;
          const fSz=useFontSz||sz;const f=useF||tyrFont;
          const leftPad=6;const fieldTopPDF=pgH-topY;const fieldBottomPDF=bottomLimit!=null?bottomLimit:(pgH-topY-h);
          const textStartY=fieldTopPDF-fSz;const maxW=w-leftPad-4;
          const rawLines=text.split(/\n/).filter(l=>l.trim());
          const useBullets=!noBullets&&rawLines.length>1;
          const bullet="\u2022  ";const bulletW=useBullets?f.widthOfTextAtSize(bullet,fSz):0;
          const textAfterBullet=leftPad+bulletW;const wrapMaxW=maxW-bulletW;
          const lines=[];
          rawLines.forEach(rl=>{const clean=rl.replace(/^[\-\•\*]\s*/,"").trim();if(!clean)return;const words=clean.split(" ");let cur="";let first=true;words.forEach(wd=>{const test=cur?cur+" "+wd:wd;const tw2=f.widthOfTextAtSize(test,fSz);if(tw2>wrapMaxW&&cur){lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});first=false;cur=wd;}else cur=test;});if(cur)lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});});
          let yOff=0;lines.forEach((ln,i)=>{if(i>0)yOff+=(ln.newBullet&&useBullets)?fSz*2.6:fSz*lineSpacing;const ly=textStartY-yOff;if(ly>=fieldBottomPDF)pg1.drawText(ln.text,{x:x+ln.xOff,y:ly,size:fSz,font:f,color:rgb(0,0,0)});});
        };

        // Build value lookup from form fields — exact name → value map
        const v={};allFields.forEach(f=>{if(f.val)v[(f.name||"").toLowerCase().trim()]=f.val;});
        // findVal: word-boundary-aware search — matches whole words in field names
        // e.g. "ot" matches "ot hours" but NOT "notes"
        // Word-start boundary match: keyword must start at a word boundary but can be a prefix
        // e.g. "note" matches "notes and comments" but "ot" does NOT match "notes"
        const wordMatch=(fieldName,keyword)=>{const re=new RegExp("(^|[\\s_\\-\\.:#])"+keyword.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i");return re.test(fieldName);};
        const findVal=(...keys)=>{for(const k of keys){for(const[fn,fv]of Object.entries(v)){if(wordMatch(fn,k))return fv;}}return"";};
        // findVal2: match field name that contains both keywords (word-boundary aware)
        const findVal2=(a,b)=>{for(const[fn,fv]of Object.entries(v)){if(wordMatch(fn,a)&&wordMatch(fn,b))return fv;}return"";};

        // Row heights are all 14.8pt
        const rh=14.8;

        // ── Header fields (grey value boxes) ──
        // Row 1: District Name / Project Name  (y=125.2)
        drawCell(findVal("district"),109.3,125.2,190.6,rh,sz,tyrFontBold);
        drawCell(findVal2("project","name"),424.4,125.2,164.1,rh,sz,tyrFontBold);
        // Row 2: Address  (y=142.2)
        drawCell(findVal("address"),109.3,142.2,479.2,rh,sz,tyrFontBold);
        // Row 3: DSA Number / TYR Project #  (y=159.3)
        drawCell(findVal("dsa"),109.3,159.3,190.6,rh,sz,tyrFontBold);
        drawCell(findVal("tyr project","project #","project#"),424.4,159.3,164.1,rh,sz,tyrFontBold);
        // Row 4: Date / Weather  (y=176.4)
        drawCell(findVal("date"),109.3,176.4,190.6,rh,sz,tyrFontBold);
        drawCell(findVal("weather"),424.4,176.4,164.1,rh,szSm,tyrFontBold);
        // Row 5: Reg Hours / OT Hours / DT Hours  (y=193.4)
        drawCell(findVal("reg"),109.3,193.4,100.5,rh,sz,tyrFont);
        drawCell(findVal("ot"),316.4,193.4,96.6,rh,sz,tyrFont);
        drawCell(findVal("dt"),523.5,193.4,65.0,rh,sz,tyrFont);

        // ── General Statement (cream box y=228.9, h=28) ──
        // "General:" label baseline sits ~2pt below 228.9 top. Start text at 229.5 to align with label.
        // Allow text to flow down into contractor table area if needed (bottom limit = contractor header y=259.2)
        drawMulti(findVal("general"),70,229.5,517.2,28,{lineSpacing:1.3,noBullets:true,bottomLimit:pgH-257});

        // ── Daily Activities (cream box below "Daily Activities:" label row) ──
        // Label row: y=344.4 h=13. Content box: y=357.4, h=80
        drawMulti(findVal("activit"),25.2,357.4,562.0,80.0,{lineSpacing:1.3});

        // ── Inspection Requests (y=439.6, h=14.8) ──
        // Label "Inspection Requests/Site Visits:" ends at x~195
        // Inspection requests — fixed height, does not grow
        drawMulti(findVal("inspection","request","site visit"),195,439.6,392.2,14.8,{lineSpacing:1.3,useFontSz:szSm,noBullets:true,bottomLimit:pgH-455});

        // ── Notes and Comments — removed from TYR PDF output ──
        // (was duplicating General field values; user will re-upload template v6 without this row)

        // ── Signature (just above footer, ~y=474) ──
        const sigEnabled=job.field_config?.digitalSignature!==false;
        const sigField=allFields.find(f=>((f.name||"").toLowerCase().includes("signature")||(f.autoFill==="name"&&(f.name||"").toLowerCase().includes("inspector"))));
        const sigName=sigField?.val||user?.user_metadata?.full_name||user?.email?.split("@")[0]||"";
        if(sigEnabled&&sigName){
          const sigSz=sz*0.85;
          const sigY=pgH-478; // place signature right below Notes section
          const sigTime=sigField?.name&&sigTimestamps[sigField.name]?new Date(sigTimestamps[sigField.name]):new Date();
          const dayName=sigTime.toLocaleDateString("en-US",{weekday:"long"});
          const datePart=sigTime.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
          const timePart=sigTime.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true});
          pg1.drawText("Signed by "+String(sigName),{x:27,y:sigY,size:sigSz,font:tyrFontItalic,color:rgb(0.1,0.1,0.1)});
          pg1.drawText(dayName+", "+datePart+" at "+timePart,{x:27,y:sigY-sigSz*1.15,size:sigSz*0.65,font:tyrFont,color:rgb(0.4,0.4,0.4)});
          pg1.drawText("powered by My Daily Reports",{x:27,y:sigY-sigSz*2.1,size:sigSz*0.55,font:tyrFontItalic,color:rgb(0.6,0.6,0.6)});
        }
      }else if(!isTYR){
      // ── Standard (non-TYR) field drawing — skip for original TYR (has its own block below) ──
      {
        allFields.forEach(f=>{
          if(f.x==null||f.y==null||!f.val)return;
          const isAutoField=f.autoFill==="date"||f.autoFill==="increment";
          if(!isAutoField&&f.originalValue&&f.val===f.originalValue)return;
          const pageIdx=(f.page||1)-1;
          if(pageIdx<0||pageIdx>=pages.length)return;
          const page=pages[pageIdx];const pageH=page.getHeight();
          const sz=f.fontSize||10;
          const fieldH=f.h||(sz*1.6);
          const isSig=f.autoFill!=="date"&&f.autoFill!=="increment"&&((f.name||"").toLowerCase().includes("signature")||(f.autoFill==="name"&&(f.name||"").toLowerCase().includes("inspector")));
          if(isSig){
            const sigSz=sz*0.85;
            const sigBlockH=sigSz*2.8;
            const pdfY=pageH-f.y-fieldH+sigBlockH+sigSz*0.3;
            const sigTime=sigTimestamps[f.name]?new Date(sigTimestamps[f.name]):new Date();
            const dayName=sigTime.toLocaleDateString("en-US",{weekday:"long"});
            const datePart=sigTime.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
            const timePart=sigTime.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true});
            page.drawText("Signed by "+String(f.val),{x:f.x+2,y:pdfY,size:sigSz,font:fontItalic,color:rgb(0.1,0.1,0.1)});
            page.drawText(dayName+", "+datePart+" at "+timePart,{x:f.x+2,y:pdfY-sigSz*1.15,size:sigSz*0.65,font,color:rgb(0.4,0.4,0.4)});
            page.drawText("powered by My Daily Reports",{x:f.x+2,y:pdfY-sigSz*2.1,size:sigSz*0.55,font:fontItalic,color:rgb(0.6,0.6,0.6)});
          }else if(f.multiline&&f.w){
            const leftPad=6;
            const fieldTopPDF=pageH-f.y;
            const fieldBottomPDF=pageH-f.y-fieldH;
            const textStartY=fieldTopPDF-sz;
            const maxW=f.w-leftPad-4;const rawLines=f.val.split(/\n/).filter(l=>l.trim());
            const useBullets=rawLines.length>1;
            const bullet="\u2022  ";
            const bulletW=useBullets?font.widthOfTextAtSize(bullet,sz):0;
            const textAfterBullet=leftPad+bulletW;
            const wrapMaxW=maxW-bulletW;
            const lines=[];
            rawLines.forEach(rl=>{
              const clean=rl.replace(/^[\-\•\*]\s*/,"").trim();
              if(!clean)return;
              const words=clean.split(" ");let cur="";let first=true;
              words.forEach(w=>{const test=cur?cur+" "+w:w;const tw=font.widthOfTextAtSize(test,sz);if(tw>wrapMaxW&&cur){lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});first=false;cur=w;}else cur=test;});
              if(cur)lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});
            });
            let yOff=0;lines.forEach((ln,i)=>{if(i>0)yOff+=(ln.newBullet&&useBullets)?sz*2:sz*1.5;const ly=textStartY-yOff;if(ly>=fieldBottomPDF)page.drawText(ln.text,{x:f.x+ln.xOff,y:ly,size:sz,font,color:rgb(0,0,0)});});
          }else{
            let useSz=sz;
            const fieldW=f.w||120;
            if(fieldW>0){const tw=font.widthOfTextAtSize(String(f.val),useSz);if(tw>fieldW-4){useSz=Math.max(6,useSz*(fieldW-4)/tw);}}
            const pdfY=pageH-f.y-(fieldH+useSz)/2+useSz*0.15;
            page.drawText(String(f.val),{x:f.x+2,y:pdfY,size:useSz,font,color:rgb(0,0,0)});
          }
        });
      }
      }
      } // end if !acroform

      // ── TYR v5: Draw contractor table on PDF page 1 — exact template coordinates ──
      // Template has 2-column contractor layout: Left(Name+MP) Right(Name+MP) + RFIs column
      // 4 data rows, so max 8 contractors (4 left + 4 right)
      if(isEnhancedTYR&&selectedContractors.length>0&&pages.length>0){
        const pg1=pages[0];
        const pgH=pg1.getHeight(); // 792
        const sz=10;
        // Column x-positions (from template analysis)
        const leftNameX=25.2;   // x for left contractor name
        const leftMpX=189;      // x for left MP value (centered in 185-225)
        const rightNameX=229;   // x for right contractor name
        const rightMpX=379;     // x for right MP value (centered in 375-415)
        const rfiX=419;         // x for RFIs/CCDs/ASIs/Submittals
        // Row y-positions in pdf-lib coords (bottom-up) — baseline for 10pt text in 14.8pt rows
        const rowYs=[504.4,487.3,470.3,453.3]; // rows 1-4
        // Split contractors: first 4 go left, next 4 go right
        const leftCs=selectedContractors.slice(0,4);
        const rightCs=selectedContractors.slice(4,8);
        const tyrF2=await pdfDoc.embedFont(StandardFonts.Helvetica);
        const tyrFB2=await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        leftCs.forEach((c,i)=>{
          if(i>=rowYs.length)return;
          pg1.drawText(c.company_name||"",{x:leftNameX,y:rowYs[i],size:sz,font:tyrFB2,color:rgb(0,0,0)});
          pg1.drawText(String(c.manpower||0),{x:leftMpX,y:rowYs[i],size:sz,font:tyrFB2,color:rgb(0,0,0)});
        });
        rightCs.forEach((c,i)=>{
          if(i>=rowYs.length)return;
          pg1.drawText(c.company_name||"",{x:rightNameX,y:rowYs[i],size:sz,font:tyrFB2,color:rgb(0,0,0)});
          pg1.drawText(String(c.manpower||0),{x:rightMpX,y:rowYs[i],size:sz,font:tyrFB2,color:rgb(0,0,0)});
        });
        // Draw RFIs/CCDs/ASIs/Submittals — split by "/" into separate rows
        const rfiVal=vals["RFIs/CCDs/ASIs/Submittals"]||"";
        if(rfiVal){
          const rfiParts=rfiVal.split("/").map(s=>s.trim()).filter(Boolean);
          rfiParts.forEach((part,ri)=>{
            if(ri>=rowYs.length)return;
            let rfiSz=9;const rfiW=170;
            const tw=tyrF2.widthOfTextAtSize(part,rfiSz);
            if(tw>rfiW)rfiSz=Math.max(6,rfiSz*rfiW/tw);
            pg1.drawText(part,{x:rfiX,y:rowYs[ri],size:rfiSz,font:tyrF2,color:rgb(0,0,0)});
          });
        }
      }

      // ── TYR Original: Hardcoded field positions for the original TYR_Daily_Report_Template ──
      // Completely separate from v5_fixed — different row positions, 4-col contractor grid, signature lines
      if(isTYR&&pages.length>0){
        const pg1=pages[0];const pgH=pg1.getHeight();
        const sz=10;const szSm=9;
        const tyrFont=await pdfDoc.embedFont(StandardFonts.Helvetica);
        const tyrFontBold=await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const tyrFontItalic=await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
        // Helper: draw single-line text, vertically centered in cell, auto-shrink
        const drawCell=(text,x,topY,w,h,useSz,useFont)=>{
          if(!text)return;
          const s=String(text);let fs=useSz||sz;const f2=useFont||tyrFont;
          const tw=f2.widthOfTextAtSize(s,fs);
          if(w&&tw>w-6)fs=Math.max(6,fs*(w-6)/tw);
          const pdfY=pgH-topY-(h+fs)/2+fs*0.15;
          pg1.drawText(s,{x:x+3,y:pdfY,size:fs,font:f2,color:rgb(0,0,0)});
        };
        // Helper: draw multiline text with word-wrap inside a box
        const drawMulti=(text,x,topY,w,h,{lineSpacing=1.3,useFontSz,useF,noBullets,bottomLimit}={})=>{
          if(!text)return;
          const fSz=useFontSz||sz;const f=useF||tyrFont;
          const leftPad=6;const fieldTopPDF=pgH-topY;const fieldBottomPDF=bottomLimit!=null?bottomLimit:(pgH-topY-h);
          const textStartY=fieldTopPDF-fSz;const maxW=w-leftPad-4;
          const rawLines=text.split(/\n/).filter(l=>l.trim());
          const useBullets=!noBullets&&rawLines.length>1;
          const bullet="\u2022  ";const bulletW=useBullets?f.widthOfTextAtSize(bullet,fSz):0;
          const textAfterBullet=leftPad+bulletW;const wrapMaxW=maxW-bulletW;
          const lines=[];
          rawLines.forEach(rl=>{const clean=rl.replace(/^[\-\•\*]\s*/,"").trim();if(!clean)return;const words=clean.split(" ");let cur="";let first=true;words.forEach(wd=>{const test=cur?cur+" "+wd:wd;const tw2=f.widthOfTextAtSize(test,fSz);if(tw2>wrapMaxW&&cur){lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});first=false;cur=wd;}else cur=test;});if(cur)lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});});
          let yOff=0;lines.forEach((ln,i)=>{if(i>0)yOff+=(ln.newBullet&&useBullets)?fSz*2.6:fSz*lineSpacing;const ly=textStartY-yOff;if(ly>=fieldBottomPDF)pg1.drawText(ln.text,{x:x+ln.xOff,y:ly,size:fSz,font:f,color:rgb(0,0,0)});});
        };

        // Build value lookup
        const v={};allFields.forEach(f=>{if(f.val)v[(f.name||"").toLowerCase().trim()]=f.val;});
        const wordMatch=(fn,kw)=>{const re=new RegExp("(^|[\\s_\\-\\.:#])"+kw.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i");return re.test(fn);};
        const findVal=(...keys)=>{for(const k of keys){for(const[fn,fv]of Object.entries(v)){if(wordMatch(fn,k))return fv;}}return"";};
        const findVal2=(a,b)=>{for(const[fn,fv]of Object.entries(v)){if(wordMatch(fn,a)&&wordMatch(fn,b))return fv;}return"";};
        const rh=14.8;

        // ── Header fields (original template positions) ──
        // All values: 9pt regular for consistency
        drawCell(findVal("district"),109.3,127.5,190.6,rh,szSm,tyrFont);
        drawCell(findVal2("project","name"),424.4,127.5,164.1,rh,szSm,tyrFont);
        // Address — merged cell spanning full width (h=27.5)
        drawCell(findVal("address"),109.3,144.5,474.2,27.5,szSm,tyrFont);
        drawCell(findVal("dsa"),109.3,174.2,190.6,rh,szSm,tyrFont);
        drawCell(findVal("tyr project","project #","project#"),424.4,174.2,164.1,rh,szSm,tyrFont);
        drawCell(findVal("date"),109.3,191.2,190.6,rh,szSm,tyrFont);
        drawCell(findVal("weather"),424.4,191.2,164.1,rh,szSm,tyrFont);
        // Hours row
        drawCell(findVal("reg"),109.3,208.2,100.5,rh,szSm,tyrFont);
        drawCell(findVal("ot"),316.4,208.2,96.6,rh,szSm,tyrFont);
        drawCell(findVal("dt"),523.5,208.2,65.0,rh,szSm,tyrFont);

        // ── General (cream box: top=258.4, h=28) ──
        // x=75 to start after "General:" label, not on top of it
        drawMulti(findVal("general"),75,258.4,512.0,28,{lineSpacing:1.3,noBullets:true,bottomLimit:pgH-286.4});

        // ── Daily Activities (cream content box: top=369.9, h=60) ──
        drawMulti(findVal("activit"),25.2,369.9,562.0,60.0,{lineSpacing:1.3});

        // ── Single-line fields (inspection requests, RFIs, etc.) ──
        drawCell(findVal("inspection","request"),135,432.1,452,rh,szSm,tyrFont);
        drawCell(findVal("rfi"),55,449.2,245,rh,szSm,tyrFont);
        drawCell(findVal("submittal"),370,449.2,217,rh,szSm,tyrFont);
        drawCell(findVal("ccd"),55,466.2,245,rh,szSm,tyrFont);
        drawCell(findVal("asi"),345,466.2,242,rh,szSm,tyrFont);
        drawCell(findVal("site visit"),80,483.3,507,rh,szSm,tyrFont);
        drawCell(findVal("note","comment"),140,500.3,447,rh,szSm,tyrFont);

        // ── Contractor table (4 columns: Name, MP, Equipment, Trade) — 3 data rows ──
        if(selectedContractors.length>0){
          const colX=[25.2,181.2,334.0,471.6];
          const colW=[156,153,138,119];
          // Row tops in pdfplumber coords: 305.7, 322.8, 339.8
          const rowTops=[305.7,322.8,339.8];
          selectedContractors.forEach((c,i)=>{
            if(i>=rowTops.length)return;
            const rowTop=rowTops[i];
            // Name
            drawCell(c.company_name||"",colX[0],rowTop,colW[0],rh,szSm,tyrFont);
            // Manpower
            drawCell(String(c.manpower||0),colX[1],rowTop,colW[1],rh,szSm,tyrFont);
            // Equipment
            drawCell(c.equipment||"",colX[2],rowTop,colW[2],rh,szSm,tyrFont);
            // Trade
            drawCell(c.trade||"",colX[3],rowTop,colW[3],rh,szSm,tyrFont);
          });
        }

        // ── Signature (at signature line positions: top=586.8, left line x=20-421, right line x=438-592) ──
        const sigEnabled=job.field_config?.digitalSignature!==false;
        const sigField=allFields.find(f=>((f.name||"").toLowerCase().includes("signature")||(f.autoFill==="name"&&(f.name||"").toLowerCase().includes("inspector"))));
        const sigName=sigField?.val||user?.user_metadata?.full_name||user?.email?.split("@")[0]||"";
        if(sigEnabled&&sigName){
          const sigSz=sz*0.85;
          const sigY=pgH-575; // just above the signature lines at y=586.8
          const sigTime=sigField?.name&&sigTimestamps[sigField.name]?new Date(sigTimestamps[sigField.name]):new Date();
          const dayName=sigTime.toLocaleDateString("en-US",{weekday:"long"});
          const datePart=sigTime.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
          const timePart=sigTime.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true});
          // Left side: inspector signature
          pg1.drawText("Signed by "+String(sigName),{x:27,y:sigY,size:sigSz,font:tyrFontItalic,color:rgb(0.1,0.1,0.1)});
          pg1.drawText(dayName+", "+datePart+" at "+timePart,{x:27,y:sigY-sigSz*1.15,size:sigSz*0.65,font:tyrFont,color:rgb(0.4,0.4,0.4)});
          // Right side: date signed
          pg1.drawText("Date: "+datePart,{x:445,y:sigY,size:sigSz,font:tyrFontItalic,color:rgb(0.1,0.1,0.1)});
          pg1.drawText("powered by My Daily Reports",{x:27,y:sigY-sigSz*2.1,size:sigSz*0.55,font:tyrFontItalic,color:rgb(0.6,0.6,0.6)});
        }
      }

      // ── 5. Remove empty trailing pages (no fields reference them) before adding photos ──
      if(pdfDoc.getPageCount()>1){
        const maxFieldPage=Math.max(...allFields.map(f=>f.page||1),1);
        for(let p=pdfDoc.getPageCount();p>maxFieldPage;p--){pdfDoc.removePage(p-1);}
      }

      // ── 6. Photos on new pages — embed header/footer clips from template onto blank pages ──
      // photoLayout: "1"=1 per page, "2"=2 per page (1 col, 2 rows), "4"=4 per page (2 cols, 2 rows)
      if(photos.length>0){
        const pageW=pages.length>0?pages[0].getWidth():612;
        const pageH=pages.length>0?pages[0].getHeight():792;
        // Determine where header ends and footer starts from field positions (top-left coords)
        const p1Fields=allFields.filter(f=>f.y!=null&&(f.page||1)===1);
        let headerBottomTL=80,footerTopTL=pageH-40; // defaults in top-left coords
        if(isAnyTYR){
          // TYR template: header ends at y=93 (logo area), footer at y=495
          headerBottomTL=93;
          footerTopTL=495;
        }else if(p1Fields.length>0){
          headerBottomTL=Math.max(Math.min(...p1Fields.map(f=>f.y))-5,0);
          footerTopTL=Math.min(Math.max(...p1Fields.map(f=>f.y+(f.h||12)))+5,pageH);
        }
        // Convert to PDF coords (bottom-left origin)
        const headerBottomPDF=pageH-headerBottomTL; // PDF y where header ends
        const footerTopPDF=pageH-footerTopTL; // PDF y where footer starts

        // Embed full template page (BBox clipping unreliable), then white-out body area
        let fullPageEmbed=null;
        if(srcDoc){
          const srcPage=srcDoc.getPage(0);
          fullPageEmbed=await pdfDoc.embedPage(srcPage);
        }

        // Photo area = between header and footer
        const photoAreaTop=headerBottomPDF-5;
        const photoAreaBottom=footerTopPDF+5;
        const usableH=photoAreaTop-photoAreaBottom;

        // Font for photo captions
        const captionFont=await pdfDoc.embedFont(StandardFonts.TimesRoman);
        const captionSize=8;

        // Embed all photos first so we know their dimensions
        const embeddedPhotos=[];
        for(let i=0;i<photos.length;i++){
          try{
            const imgData=photos[i].src||photos[i];
            let img;
            if(typeof imgData==="string"&&imgData.startsWith("data:image/png"))img=await pdfDoc.embedPng(imgData);
            else if(typeof imgData==="string")img=await pdfDoc.embedJpg(imgData);
            if(img)embeddedPhotos.push({img,ratio:img.width/img.height,isLandscape:img.width>=img.height,caption:photos[i].caption||""});
          }catch(imgErr){console.error("Photo embed error:",imgErr);}
        }

        const perPage=photoLayout==="1"?1:photoLayout==="2"?2:4;
        const bodyW=pageW-72;

        // "ATTACHMENT" label font
        const attachFont=await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const attachSize=11;
        const attachLabelH=attachSize+6; // height reserved for "ATTACHMENT" label

        const addPhotoPage=()=>{
          const np=pdfDoc.addPage([pageW,pageH]);
          if(fullPageEmbed){
            np.drawPage(fullPageEmbed,{x:0,y:0,width:pageW,height:pageH});
            // White-out the body area between header and footer — extend 2px extra each side
            np.drawRectangle({x:0,y:footerTopPDF-2,width:pageW,height:(headerBottomPDF-footerTopPDF)+4,color:rgb(1,1,1)});
          }
          // Draw "ATTACHMENT" label below header
          np.drawText("ATTACHMENT",{x:36,y:photoAreaTop-attachSize,size:attachSize,font:attachFont,color:rgb(0,0,0)});
          return np;
        };

        // Helper: draw a thin border box, then the image centered inside it
        const drawPhotoInBox=(pg,img,ratio,boxX,boxY,boxW,boxH)=>{
          // Draw border box (thin black outline)
          pg.drawRectangle({x:boxX,y:boxY,width:boxW,height:boxH,borderColor:rgb(0,0,0),borderWidth:0.75,color:rgb(1,1,1)});
          // Fit image inside box with 8pt padding
          const pad=8;
          const innerW=boxW-pad*2;const innerH=boxH-pad*2;
          let imgW,imgH;
          if(ratio>=1){imgW=Math.min(innerW,innerH*ratio);imgH=imgW/ratio;}
          else{imgH=Math.min(innerH,innerW/ratio);imgW=imgH*ratio;}
          const imgX=boxX+pad+(innerW-imgW)/2;
          const imgY=boxY+pad+(innerH-imgH)/2;
          pg.drawImage(img,{x:imgX,y:imgY,width:imgW,height:imgH});
        };

        // Helper: draw caption text centered below an image
        const drawCaption=(pg,caption,imgX,imgY,imgW)=>{
          if(!caption)return;
          const maxCaptionW=imgW+40;
          let txt=caption.length>120?caption.slice(0,117)+"...":caption;
          const tw=captionFont.widthOfTextAtSize(txt,captionSize);
          const cx=imgX+(imgW-Math.min(tw,maxCaptionW))/2;
          pg.drawText(txt,{x:Math.max(36,cx),y:imgY-captionSize-4,size:captionSize,font:captionFont,color:rgb(0.3,0.3,0.3),maxWidth:maxCaptionW});
        };

        // Available area for photo boxes (below "ATTACHMENT" label)
        const boxAreaTop=photoAreaTop-attachLabelH-6;
        const boxAreaH=boxAreaTop-photoAreaBottom-10;

        for(let i=0;i<embeddedPhotos.length;){
          if(photoLayout==="1"){
            // 1 per page — large centered photo in bordered box (matches VIS/standard style)
            const pg=addPhotoPage();
            const {img,ratio,caption}=embeddedPhotos[i];
            const boxX=36;const boxW=bodyW;
            const boxH=boxAreaH;const boxY=boxAreaTop-boxH;
            drawPhotoInBox(pg,img,ratio,boxX,boxY,boxW,boxH);
            if(caption) drawCaption(pg,caption,boxX,boxY,boxW);
            i++;
          }else if(photoLayout==="2"){
            // 2 per page — stacked vertically in bordered boxes
            const pair=[embeddedPhotos[i]];
            if(i+1<embeddedPhotos.length)pair.push(embeddedPhotos[i+1]);
            const pg=addPhotoPage();
            const boxGap=10;
            const boxX=36;const boxW=bodyW;
            const boxH=pair.length===1?boxAreaH:(boxAreaH-boxGap)/2;
            pair.forEach((p,r)=>{
              const {img,ratio,caption}=p;
              const boxY=boxAreaTop-boxH-(r*(boxH+boxGap));
              drawPhotoInBox(pg,img,ratio,boxX,boxY,boxW,boxH);
              if(caption) drawCaption(pg,caption,boxX,boxY,boxW);
            });
            i+=pair.length;
          }else{
            // 4 per page — 2x2 grid in bordered boxes
            const cols=2;const rows=2;
            const chunk=embeddedPhotos.slice(i,i+4);
            const pg=addPhotoPage();
            const gapX=10;const gapY=10;
            const boxW=(bodyW-gapX)/cols;const boxH=(boxAreaH-gapY)/rows;
            chunk.forEach((p,idx)=>{
              const {img,ratio}=p;
              const col=idx%cols;const row=Math.floor(idx/cols);
              const boxX=36+col*(boxW+gapX);
              const boxY=boxAreaTop-boxH-(row*(boxH+gapY));
              drawPhotoInBox(pg,img,ratio,boxX,boxY,boxW,boxH);
            });
            i+=chunk.length;
          }
        }
      }

      // ── 6. Serialize filled PDF ──
      const filledPdfBytes=await pdfDoc.save();
      const pdfBlob=new Blob([filledPdfBytes],{type:"application/pdf"});
      const uint8=new Uint8Array(filledPdfBytes);
      const chunks=[];for(let i=0;i<uint8.length;i+=8192)chunks.push(String.fromCharCode.apply(null,uint8.subarray(i,i+8192)));
      const pdfBase64=btoa(chunks.join(""));

      // ── 7. Build filename using AI-detected convention ──
      let rptNumber=1;
      try{const cntR=await fetch(`${SB_URL}/rest/v1/reports?select=report_number&job_id=eq.${job.id}&order=report_number.desc&limit=1`,{headers:db._h()});const topR=cntR.ok?await cntR.json():[];if(topR[0]?.report_number)rptNumber=topR[0].report_number+1;}catch(e){}
      if(draftId){try{const exR=await fetch(`${SB_URL}/rest/v1/reports?select=report_number,report_date&id=eq.${draftId}`,{headers:db._h()});const exD=exR.ok?await exR.json():[];if(exD[0]?.report_number&&exD[0]?.report_date===submitDate)rptNumber=exD[0].report_number;}catch(e){}}
      const conv=job.field_config?.filenameConvention||{};
      const padding=conv.numberPadding||0;
      const rptNum=padding>0?String(rptNumber).padStart(padding,"0"):String(rptNumber);
      // Format report date according to the AI-detected format
      const now=new Date(submitDate+"T12:00:00");
      const fmtMM=now.toLocaleDateString("en-US",{month:"2-digit",timeZone:tz});
      const fmtDD=now.toLocaleDateString("en-US",{day:"2-digit",timeZone:tz});
      const fmtYYYY=now.toLocaleDateString("en-US",{year:"numeric",timeZone:tz});
      const monthNames=["January","February","March","April","May","June","July","August","September","October","November","December"];
      const monNames=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const monthIdx=now.toLocaleDateString("en-US",{month:"numeric",timeZone:tz})-1;
      const fmtMonth=monthNames[monthIdx]||"";
      const fmtMon=monNames[monthIdx]||"";
      const fmtDay=String(parseInt(fmtDD));
      const formatDate=(fmt)=>{
        if(!fmt)return"";
        // If fmt contains tokens like MM, DD, YYYY, Mon, Month — do token replacement
        if(/MM|DD|YYYY|Month|Mon/.test(fmt)){
          return fmt.replace(/YYYY/g,fmtYYYY).replace(/MM/g,fmtMM).replace(/DD/g,fmtDD).replace(/Month/g,fmtMonth).replace(/Mon/g,fmtMon);
        }
        // Otherwise fmt is a literal date from the template — detect its format and generate today's date
        const f=fmt.trim();
        if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(f))return now.toLocaleDateString("en-US",{timeZone:tz});
        if(/^\d{4}-\d{2}-\d{2}$/.test(f))return now.toLocaleDateString("en-CA",{timeZone:tz});
        if(/^[A-Za-z]{3}\s+\d{1,2},?\s+\d{4}$/.test(f))return now.toLocaleDateString("en-US",{month:"short",day:"2-digit",year:"numeric",timeZone:tz});
        if(/^[A-Za-z]+\s+\d{1,2},?\s+\d{4}$/.test(f))return now.toLocaleDateString("en-US",{month:"long",day:"2-digit",year:"numeric",timeZone:tz});
        if(/^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(f)){const pd=f.startsWith("0");return now.toLocaleDateString("en-US",{day:pd?"2-digit":"numeric",month:"long",year:"numeric",timeZone:tz}).replace(/^(\w+)\s(\d+),\s(\d+)$/,(_,m,d,y)=>`${pd?d.padStart(2,"0"):d} ${m} ${y}`);}
        if(/^[A-Za-z]{3}\s+\d{1,2}$/.test(f))return fmtMon+" "+fmtDD.replace(/^0/,"");
        if(/^\d{2}-\d{2}-\d{4}$/.test(f))return fmtMM+"-"+fmtDD+"-"+fmtYYYY;
        return now.toLocaleDateString("en-US",{timeZone:tz});
      };
      // Build filename — use user-edited filename if they changed it, otherwise compute from pattern
      let baseName;
      if(filenameEdited&&editFilename.trim()){
        baseName=editFilename.trim().replace(/\.pdf$/i,"");
        // Learn: reverse-engineer a pattern from user's edit for future reports
        try{
          let learned=baseName;
          // Replace today's date with {date} token
          const dateVariants=[fmtMon+" "+fmtDay+"_"+fmtYYYY,fmtMon+" "+fmtDay+", "+fmtYYYY,fmtMon+" "+fmtDay+" "+fmtYYYY,fmtMM+"/"+fmtDD+"/"+fmtYYYY,fmtMM+"-"+fmtDD+"-"+fmtYYYY,fmtYYYY+"-"+fmtMM+"-"+fmtDD];
          for(const dv of dateVariants){if(learned.includes(dv)){learned=learned.replace(dv,"{date}");break;}}
          // Replace report number with {report_number} token
          if(learned.includes(rptNum))learned=learned.replace(rptNum,"{report_number}");
          // Save learned pattern back to job if it differs
          const oldPattern=conv.pattern||job.report_filename_pattern||"";
          if(learned!==oldPattern&&learned!==baseName){
            const newConv={...conv,pattern:learned};
            db.updateJobFieldConfig(job.id,{...job.field_config,filenameConvention:newConv}).catch(e=>console.error("Pattern save:",e));
          }
        }catch(learnErr){console.error("Pattern learn:",learnErr);}
      }else{
        const pattern=conv.pattern||job.report_filename_pattern||job.name||"Report";
        baseName=pattern.replace(/\.[^.]+$/,"");
        const hasDateToken=baseName.includes("{date}")||baseName.includes("{year}");
        const hasNumToken=baseName.includes("{report_number}");
        baseName=baseName.replace(/\{report_number\}/g,rptNum);
        const dateStr=formatDate(conv.dateFormat);
        baseName=baseName.replace(/\{date\}/g,dateStr);
        baseName=baseName.replace(/\{year\}/g,fmtYYYY);
        baseName=baseName.replace(/\{project\}/g,(job.name||"").replace(/\s+/g,"_"));
        if(!hasDateToken){
          const litDateRx=/(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s_]+\d{1,2}[,\s_]+\d{4}/;
          const newDateStr=fmtMon+" "+fmtDay+"_"+fmtYYYY;
          if(litDateRx.test(baseName)){baseName=baseName.replace(litDateRx,newDateStr);}
          else{baseName+="_"+newDateStr;}
        }
        if(!hasNumToken){
          const replaced=baseName.replace(/_(\d+)(?=_)/,()=>"_"+rptNum);
          if(replaced===baseName)baseName=rptNum+"_"+baseName;
          else baseName=replaced;
        }
      }
      const pdfFilename=baseName+".pdf";

      // ── 8. Upload PDF first, THEN save report record (ensures file exists before marking submitted) ──
      setSubmitStep("Uploading report...");
      const storagePath=`${user.id}/${job.id}/reports/${pdfFilename}`;
      await api.uploadStorage(storagePath,pdfBlob,"application/pdf");

      setSubmitStep("Saving report...");
      const reportContent={vals,lockVals,photos,photoLayout,lockFields,editFields,...(isAnyTYR?{contractors:selectedContractors}:{})};
      await db.saveReport({
        job_id:job.id,user_id:user.id,report_date:submitDate,status:"submitted",
        content:JSON.stringify(reportContent),updated_at:new Date().toISOString()
      });
      if(isAnyTYR&&selectedContractors.length>0&&draftId)try{await db.saveReportContractors(draftId,job.id,user.id,selectedContractors);}catch(e){console.error("Save report contractors:",e);}

      const userName=user.user_metadata?.full_name||user.email?.split("@")[0]||"Inspector";
      // Build optional photo thumbnails for email
      const photoThumbs=photos.length>0?photos.slice(0,6).map(p=>{const src=typeof p==="string"?p:(p.dataUrl||p.url||"");return src?`<img src="${src}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid #ddd;" alt="Site photo"/>`:"";}).filter(Boolean).join(""):"";
      const photoSection=photoThumbs?`<div style="margin-top:16px;"><p style="color:#888;font-size:12px;margin:0 0 8px;">Site Photos (${photos.length}):</p><div style="display:flex;flex-wrap:wrap;gap:8px;">${photoThumbs}</div></div>`:"";
      const emailHtml=`<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;"><div style="background:#e8742a;padding:20px 24px;border-radius:8px 8px 0 0;"><h1 style="color:#fff;margin:0;font-size:20px;">My Daily Reports</h1></div><div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;"><p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 8px;">Hi,</p><p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 16px;">${userName} has submitted the daily field report for <strong>${job.name}</strong> on ${todayDisplay}.</p><p style="color:#555;font-size:14px;margin:0;">The full PDF report is attached to this email.</p>${photoSection}</div><p style="color:#999;font-size:11px;text-align:center;margin-top:16px;">Sent via My Daily Reports &bull; mydailyreports.org</p></div>`;

      // Store PDF info and show post-submit options instead of auto-emailing
      const rawTeam=job.team_emails||[];
      const teamEmails=rawTeam.map(m=>typeof m==="string"?m:m.email).filter(Boolean);
      setSubmitSuccess({pdfBlob,pdfFilename,pdfBase64,emailHtml,teamEmails,jobName:job.name,todayDisplay,userName});
      showToast("Report submitted!");
    }catch(e){
      console.error("Submit error:",e);
      showToast("Submit failed: "+e.message+" "+authDiag());
    }finally{busyRef.current=false;setSubmitting(false);}
  };

  // Post-submit: Download/save PDF to device
  const downloadPdf=async()=>{
    if(!submitSuccess)return;
    const isMobile=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if(isMobile){
      // Mobile: use Web Share API for "Save to Files" / AirDrop / share sheet
      const file=new File([submitSuccess.pdfBlob],submitSuccess.pdfFilename,{type:"application/pdf"});
      if(navigator.canShare&&navigator.canShare({files:[file]})){
        try{await navigator.share({files:[file],title:submitSuccess.pdfFilename});showToast("PDF shared!");return;}catch(e){if(e.name==="AbortError")return;}
      }
    }
    // Desktop (or mobile fallback): trigger direct file download
    const url=URL.createObjectURL(submitSuccess.pdfBlob);
    const a=document.createElement("a");a.href=url;a.download=submitSuccess.pdfFilename;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("PDF downloaded!");
  };

  // Post-submit: Email to project team
  const [emailing,setEmailing]=useState(false);
  const [emailFallback,setEmailFallback]=useState(null); // null = no error, object = fallback UI data
  const emailToTeam=async()=>{
    if(!submitSuccess)return;
    setEmailing(true);
    setEmailFallback(null);
    try{
      // ── Pre-flight check: verify auth + edge function BEFORE attempting the real call ──
      const pf=await preflightCheck("send-report");
      if(!pf.ok){
        const userEmail=user?.email;
        const recipients=[...new Set([userEmail,...(submitSuccess.teamEmails||[])])].filter(Boolean);
        setEmailFallback({recipients,subject:`${submitSuccess.jobName} — Daily Report ${submitSuccess.todayDisplay}`});
        setEmailing(false);return;
      }

      const userEmail=user?.email;
      const recipients=[...new Set([userEmail,...submitSuccess.teamEmails])].filter(Boolean);
      if(recipients.length===0){showToast("No team emails configured. Add them in Job Settings.");setEmailing(false);return;}
      // Get company name for dynamic sender
      let senderName="My Daily Reports";
      try{const prof=await db.getProfile(user.id);if(prof?.company_name)senderName=prof.company_name;}catch(e){}
      await api.sendReport({to:recipients,subject:`${submitSuccess.jobName} — Daily Report ${submitSuccess.todayDisplay}`,html_body:submitSuccess.emailHtml,pdf_base64:submitSuccess.pdfBase64,pdf_filename:submitSuccess.pdfFilename,sender_name:senderName});
      showToast("Report emailed to "+recipients.length+" recipient"+(recipients.length>1?"s":"")+"!");
    }catch(e){
      console.error("Email error:",e);
      // Show fallback UI instead of cryptic error messages
      const userEmail=user?.email;
      const recipients=[...new Set([userEmail,...(submitSuccess.teamEmails||[])])].filter(Boolean);
      setEmailFallback({recipients,subject:`${submitSuccess.jobName} — Daily Report ${submitSuccess.todayDisplay}`});
    }finally{setEmailing(false);}
  };

  // Fallback: open the user's mail app with recipients + subject pre-filled
  const openMailFallback=()=>{
    if(!emailFallback||!submitSuccess)return;
    const to=emailFallback.recipients.join(",");
    const subj=encodeURIComponent(emailFallback.subject);
    const body=encodeURIComponent("Daily report attached. (Please attach the downloaded PDF to this email.)");
    window.location.href=`mailto:${to}?subject=${subj}&body=${body}`;
  };

  // Fallback: copy recipient list to clipboard
  const copyRecipients=async()=>{
    if(!emailFallback)return;
    try{await navigator.clipboard.writeText(emailFallback.recipients.join(", "));showToast("Recipients copied!");}catch(e){showToast("Couldn't copy");}
  };

  const fs={width:"100%",boxSizing:"border-box",padding:"14px 16px",background:C.inp,border:`2px solid ${C.brd}`,borderRadius:12,color:C.txt,fontSize:16,fontFamily:"inherit"};
  const cardStyle={background:C.card,borderRadius:16,padding:"16px 18px",marginBottom:16,border:`1px solid ${C.brd}`,boxShadow:"0 2px 12px rgba(0,0,0,0.2)"};
  const sectionLabel=(icon,text,count)=>(<div style={{fontSize:13,color:C.mut,fontWeight:700,marginBottom:14,display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:16}}>{icon}</span><span style={{letterSpacing:1}}>{text}</span>{count!=null&&<span style={{fontSize:12,color:C.org,fontWeight:700,background:C.org+"18",borderRadius:12,padding:"2px 10px",marginLeft:"auto"}}>{count}</span>}</div>);
  const layouts=[{k:"1",l:"1 per page"},{k:"2",l:"2 per page (auto)"},{k:"4",l:"4 per page"}];

  if(loadingDraft)return(<div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}><p style={{color:C.mut}}>Loading report...</p></div>);

  // ── View Report Screen (canvas-rendered preview of template + field values) ──
  if(viewingReport){
    const isDocxPreview=viewingReport[0]==="__docx_html__"&&viewDocxHtml;
    const useEditable=editablePreview&&!isDocxPreview;
    // Helper: update a field value from the editable preview overlay
    const handlePreviewFieldChange=(fieldName,newVal,isLocked)=>{
      if(isLocked){setLockVal(fieldName,newVal);}
      else{setVal(fieldName,newVal);}
    };
    return(
      <div style={{minHeight:"100vh",background:C.bg,color:C.txt,display:"flex",flexDirection:"column"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",borderBottom:`1px solid ${C.brd}`,background:C.card}}>
          <button onClick={()=>{closeCamera();setViewingReport(null);setViewDocxHtml(null);setEditablePreview(null);}} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:17}}>{useEditable?"Edit on Preview":"Report Preview"}</div>
            <div style={{fontSize:12,color:C.mut}}>{useEditable?"Click any field to edit directly on the PDF":"This is how your report will look"}</div>
          </div>
        </div>
        <div style={{flex:1,overflow:"auto",WebkitOverflowScrolling:"touch",padding:"12px 16px",maxWidth:useEditable?900:"none",margin:useEditable?"0 auto":"0"}}>
          {isDocxPreview?(
            <div style={{background:"#fff",borderRadius:4,padding:"24px 20px",boxShadow:"0 1px 6px rgba(0,0,0,0.4)",color:"#222",fontSize:14,lineHeight:1.6}} dangerouslySetInnerHTML={{__html:viewDocxHtml}}/>
          ):useEditable?(
            editablePreview.pages.map((pg,pi)=>{
              const pageNum=pi+1;
              const pageFields=editablePreview.fields.filter(f=>(f.page||1)===pageNum&&f.x!=null&&f.y!=null);
              return(
                <div key={pi} style={{position:"relative",marginBottom:16,borderRadius:4,overflow:"hidden",boxShadow:"0 2px 12px rgba(0,0,0,0.5)"}}>
                  <img src={pg.imgUrl} style={{width:"100%",display:"block"}} alt={"Page "+(pi+1)}/>
                  {pageFields.map((f,fi)=>{
                    const isLocked=lockFields.some(lf=>lf.name===f.name);
                    const isAuto=f.autoFill==="date"||f.autoFill==="increment";
                    const isSig=(f.name||"").toLowerCase().includes("signature")||(f.autoFill==="name"&&(f.name||"").toLowerCase().includes("inspector"));
                    const leftPct=(f.x/pg.w*100);
                    const topPct=(f.y/pg.h*100);
                    const wPct=((f.w||100)/pg.w*100);
                    const hPct=f.multiline?Math.max(((f.h||30)/pg.h*100),6):((f.fontSize||10)*1.8/pg.h*100);
                    const fSizePct=((f.fontSize||10)/pg.h*100);
                    const curVal=isLocked?(lockVals[f.name]||f.value||""):(vals[f.name]||"");
                    if(isSig)return(
                      <div key={fi} style={{position:"absolute",left:leftPct+"%",top:topPct+"%",width:wPct+"%",fontSize:"clamp(8px,"+fSizePct+"vw,13px)",color:"#1a1a1a",fontStyle:"italic",fontFamily:"Georgia,serif",pointerEvents:"none",lineHeight:1.3}}>
                        {curVal&&<>Signed by {curVal}</>}
                      </div>
                    );
                    return f.multiline?(
                      <textarea key={fi} value={curVal} onChange={e=>handlePreviewFieldChange(f.name,e.target.value,isLocked)} readOnly={isAuto} placeholder={f.name} style={{position:"absolute",left:leftPct+"%",top:topPct+"%",width:wPct+"%",height:hPct+"%",minHeight:24,background:isAuto?"rgba(90,143,192,0.08)":"rgba(255,255,255,0.85)",border:"1px solid "+(isAuto?"rgba(90,143,192,0.3)":"rgba(232,116,42,0.4)"),borderRadius:2,padding:"2px 3px",fontSize:"clamp(8px,"+fSizePct+"vw,13px)",fontFamily:"Georgia,Cambria,serif",color:"#000",resize:"none",outline:"none",cursor:isAuto?"default":"text",lineHeight:1.4,overflow:"hidden"}}/>
                    ):(
                      <input key={fi} type="text" value={curVal} onChange={e=>handlePreviewFieldChange(f.name,e.target.value,isLocked)} readOnly={isAuto} placeholder={f.name} style={{position:"absolute",left:leftPct+"%",top:topPct+"%",width:wPct+"%",height:"auto",background:isAuto?"rgba(90,143,192,0.08)":"rgba(255,255,255,0.85)",border:"1px solid "+(isAuto?"rgba(90,143,192,0.3)":"rgba(232,116,42,0.4)"),borderRadius:2,padding:"1px 3px",fontSize:"clamp(8px,"+fSizePct+"vw,13px)",fontFamily:"Georgia,Cambria,serif",color:"#000",outline:"none",cursor:isAuto?"default":"text"}}/>
                    );
                  })}
                </div>
              );
            })
          ):(
            viewingReport.map((dataUrl,i)=>(
              <div key={i} style={{marginBottom:12,borderRadius:4,overflow:"hidden",boxShadow:"0 1px 6px rgba(0,0,0,0.4)"}}>
                <img src={dataUrl} style={{width:"100%",display:"block"}} alt={"Page "+(i+1)}/>
              </div>
            ))
          )}
        </div>
        <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"14px 20px",borderTop:`1px solid ${C.brd}`,background:C.card,zIndex:100,display:"flex",gap:10,maxWidth:useEditable?900:"none",margin:useEditable?"0 auto":"0"}}>
          <button onClick={()=>{closeCamera();setViewingReport(null);setViewDocxHtml(null);setEditablePreview(null);}} style={{padding:"14px 16px",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,color:C.mut,fontSize:15,fontWeight:700,cursor:"pointer"}}>
            ←
          </button>
          <button onClick={async()=>{closeCamera();await saveWorking();setViewingReport(null);setViewDocxHtml(null);setEditablePreview(null);onBack();}} disabled={saving} style={{flex:1,padding:"14px 0",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15,fontWeight:700,cursor:"pointer",opacity:saving?0.5:1}}>
            {saving?"Saving...":"Save & Exit"}
          </button>
          <button onClick={()=>{setViewingReport(null);setViewDocxHtml(null);setEditablePreview(null);submitReport();}} disabled={submitting} className="btn-o" style={{flex:1,padding:"14px 0",background:C.org,border:"none",borderRadius:10,color:"#fff",fontSize:15,fontWeight:700,cursor:submitting?"default":"pointer",opacity:submitting?0.6:1}}>
            {submitting?"Submitting...":"Submit"}
          </button>
        </div>
      </div>
    );
  }

  // ── Post-Submit Success Screen — Download or Email options ──
  if(submitSuccess){
    const teamCount=submitSuccess.teamEmails.length;
    const hasTeam=teamCount>0||user.email;
    return(
      <div style={{minHeight:"100vh",background:C.bg,color:C.txt,display:"flex",flexDirection:"column"}}>
        {toast&&<div style={{position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",background:C.card,border:`1px solid ${C.ok}`,borderRadius:10,padding:"10px 20px",fontSize:14,fontWeight:600,color:C.ok,zIndex:9999}}>{toast}</div>}
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",borderBottom:`1px solid ${C.brd}`,background:C.card}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:17}}>Report Submitted</div>
            <input type="text" value={submitSuccess.pdfFilename} onChange={e=>setSubmitSuccess(p=>({...p,pdfFilename:e.target.value}))} style={{width:"100%",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:6,padding:"6px 8px",fontSize:12,color:C.lt,textAlign:"center",outline:"none"}} onClick={e=>e.target.select()}/>
          </div>
        </div>
        <div style={{flex:1,padding:"24px 20px",display:"flex",flexDirection:"column",alignItems:"center",gap:20}}>
          <div style={{width:64,height:64,borderRadius:"50%",background:C.ok+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>✓</div>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:18,fontWeight:700,marginBottom:6}}>Report Saved Successfully</div>
            <div style={{fontSize:14,color:C.mut}}>Choose how to deliver your report</div>
          </div>

          <div style={{width:"100%",maxWidth:400,display:"flex",flexDirection:"column",gap:12}}>
            {/* Download to device */}
            <button onClick={downloadPdf} style={{width:"100%",padding:"16px 20px",background:C.blu,border:"none",borderRadius:12,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:22}}>⬇</span>
              <div style={{textAlign:"left"}}>
                <div>Download PDF</div>
                <div style={{fontSize:11,fontWeight:400,opacity:0.8}}>Save to your device</div>
              </div>
            </button>

            {/* Email to team */}
            {!emailFallback?(
              <button onClick={emailToTeam} disabled={emailing} style={{width:"100%",padding:"16px 20px",background:C.org,border:"none",borderRadius:12,color:"#fff",fontSize:15,fontWeight:700,cursor:emailing?"default":"pointer",opacity:emailing?0.7:1,display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:22}}>✉</span>
                <div style={{textAlign:"left"}}>
                  <div>{emailing?"Sending...":"Email to Project Team"}</div>
                  <div style={{fontSize:11,fontWeight:400,opacity:0.8}}>
                    {emailing?"Emails may take up to 5 minutes to arrive. Do not resend."
                      :teamCount>0
                      ?`Send to ${teamCount+1} recipient${teamCount+1>1?"s":""} (you + ${teamCount} team)`
                      :user?.email?"Send to "+user.email:"No team emails configured"}
                  </div>
                </div>
              </button>
            ):(
              <div style={{width:"100%",background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:"16px 18px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                  <span style={{fontSize:18}}>⚠</span>
                  <div style={{fontSize:14,fontWeight:700,color:"#f59e0b"}}>Email isn't available right now</div>
                </div>
                <div style={{fontSize:13,color:C.lt,lineHeight:1.5,marginBottom:16}}>
                  Your report is saved. Use one of these options to deliver it:
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <button onClick={()=>{downloadPdf();}} style={{width:"100%",padding:"12px 16px",background:C.blu,border:"none",borderRadius:10,color:"#fff",fontSize:14,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:10}}>
                    <span>⬇</span> Download PDF, then email manually
                  </button>
                  <button onClick={openMailFallback} style={{width:"100%",padding:"12px 16px",background:C.org,border:"none",borderRadius:10,color:"#fff",fontSize:14,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:10}}>
                    <span>✉</span> Open in Mail App (attach PDF yourself)
                  </button>
                  <button onClick={copyRecipients} style={{width:"100%",padding:"10px 16px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.lt,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",gap:10}}>
                    <span>📋</span> Copy recipient list ({emailFallback.recipients.length})
                  </button>
                </div>
                <button onClick={()=>{setEmailFallback(null);}} style={{width:"100%",marginTop:12,padding:"8px",background:"none",border:"none",color:C.mut,fontSize:12,cursor:"pointer",textDecoration:"underline"}}>
                  Try email again
                </button>
              </div>
            )}

          </div>

          <div style={{width:"100%",maxWidth:400,borderTop:`1px solid ${C.brd}`,paddingTop:16,marginTop:8}}>
            <button onClick={()=>{setSubmitSuccess(null);onBack();}} style={{width:"100%",padding:"14px 0",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,color:C.mut,fontSize:14,fontWeight:600,cursor:"pointer"}}>
              Done — Back to Job
            </button>
          </div>
        </div>
      </div>
    );
  }

  return(
    <div className="page-in" style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      {/* Submitting overlay */}
      {submitting&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:300,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
          <div style={{width:48,height:48,border:"3px solid "+C.brd,borderTopColor:C.org,borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
          <div style={{fontSize:16,fontWeight:700,color:C.txt}}>{submitStep||"Generating Report..."}</div>
          <div style={{fontSize:13,color:C.mut}}>Please don't close this screen</div>
          <button onClick={()=>{reSavingRef.current=false;setSaving(false);busyRef.current=false;setSubmitting(false);}} style={{marginTop:12,padding:"10px 24px",background:"transparent",border:`1px solid ${C.brd}`,borderRadius:8,color:C.mut,fontSize:13,cursor:"pointer"}}>Cancel</button>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}
      {/* Toast */}
      {toast&&<div style={{position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",background:C.card,border:`1px solid ${C.ok}`,borderRadius:10,padding:"10px 20px",fontSize:14,fontWeight:600,color:C.ok,zIndex:9999}}>{toast}</div>}
      {/* Header */}
      <div style={{borderBottom:`1px solid ${C.brd}`,background:C.card,padding:"14px 16px"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,maxWidth:600,margin:"0 auto"}}>
        <button onClick={async()=>{closeCamera();await saveWorking();onBack();}} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:700,fontSize:17}}>{reportStatus==="submitted"?"Submitted Report":"Today's Report"}</div>
          <div style={{fontSize:12,color:C.mut,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{job.name}</div>
        </div>
        {reportStatus==="submitted"&&<span style={{padding:"4px 10px",fontSize:11,fontWeight:700,borderRadius:6,background:C.ok+"22",color:C.ok}}>Submitted</span>}
        <button onClick={()=>setFieldMode(!fieldMode)} title={fieldMode?"Switch to Full Editor":"Switch to Field Mode — simplified for walking around"} aria-label={fieldMode?"Switch to full editor":"Switch to field mode"} style={{background:fieldMode?C.org:"transparent",border:`1px solid ${fieldMode?C.org:C.brd}`,borderRadius:8,padding:"8px 10px",cursor:"pointer",color:fieldMode?"#fff":C.mut,fontSize:18,lineHeight:1,minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center"}}>{fieldMode?"📋":"📱"}</button>
      </div>
      </div>

      {/* ── Field Mode — simplified mobile view for walking around ── */}
      {fieldMode&&(
        <div style={{maxWidth:600,margin:"0 auto",padding:"16px 16px 160px"}}>
          <div style={{textAlign:"center",marginBottom:12}}>
            <span style={{display:"inline-block",padding:"4px 14px",fontSize:11,fontWeight:700,borderRadius:6,background:C.org,color:"#fff",letterSpacing:1}}>FIELD MODE</span>
            <div style={{fontSize:12,color:C.mut,marginTop:4}}>{todayDisplay}</div>
          </div>

          {/* Camera viewfinder overlay */}
          {cameraOpen&&(
            <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"#000",zIndex:9999,display:"flex",flexDirection:"column"}}>
              <video ref={videoRef} autoPlay playsInline muted style={{flex:1,objectFit:"cover",width:"100%"}}/>
              <div style={{position:"absolute",bottom:0,left:0,right:0,padding:"24px 20px",display:"flex",alignItems:"center",justifyContent:"center",gap:24,background:"linear-gradient(transparent,rgba(0,0,0,0.7))"}}>
                <button onClick={closeCamera} style={{width:50,height:50,borderRadius:"50%",background:"rgba(255,255,255,0.2)",border:"2px solid #fff",color:"#fff",fontSize:20,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                <button onClick={takePhoto} style={{width:72,height:72,borderRadius:"50%",background:"#fff",border:"4px solid rgba(255,255,255,0.5)",cursor:"pointer",boxShadow:"0 2px 12px rgba(0,0,0,0.3)"}}/>
                <div style={{width:50,height:50}}/>
              </div>
            </div>
          )}

          {/* Big camera button */}
          <button onClick={openCamera} style={{width:"100%",padding:"20px 0",background:C.org,border:"none",borderRadius:14,color:"#fff",fontSize:18,fontWeight:700,cursor:"pointer",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
            <span style={{fontSize:28}}>📷</span> SNAP PHOTO
          </button>
          <input ref={fieldPhotoRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{display:"none"}}/>

          {/* Photo strip */}
          {photos.length>0&&(
            <div style={{display:"flex",gap:8,overflowX:"auto",WebkitOverflowScrolling:"touch",marginBottom:16,paddingBottom:4}}>
              {photos.map(p=>(
                <div key={p.id} style={{position:"relative",flexShrink:0,width:72,height:72,borderRadius:8,overflow:"hidden",border:`1px solid ${C.brd}`}}>
                  <img src={p.src} alt={p.name} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                  <button onClick={()=>setPhotos(prev=>prev.filter(x=>x.id!==p.id))} style={{position:"absolute",top:2,right:2,width:20,height:20,borderRadius:"50%",background:"rgba(0,0,0,0.7)",border:"none",color:"#fff",fontSize:10,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                </div>
              ))}
            </div>
          )}

          {/* Editable fields — only non-auto, non-skipped */}
          {editFields.filter(f=>{
            if(f.autoFill==="date"||f.autoFill==="increment"||f.autoFill==="name")return false;
            // TYR: field mode only shows Daily Activities — everything else is on the full editor
            if(isAnyTYR){return /activit/i.test(f.name||"");}
            return true;
          }).map(f=>{
            const isSkipped=skippedFields[f.name];
            return(
            <div key={f.name} style={{marginBottom:14,opacity:isSkipped?0.4:1,transition:"opacity 0.2s"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                <label style={{fontSize:13,fontWeight:600,color:isSkipped?C.mut:C.lt}}>{f.name}{isSkipped?" — skipped":""}</label>
                <div style={{display:"flex",gap:4,alignItems:"center"}}>
                  {!isSkipped&&vals[f.name]&&(
                    <button onClick={()=>relockField(f.name)} title="Lock this field" style={{padding:"4px 8px",fontSize:10,fontWeight:700,borderRadius:4,border:`1px solid ${C.blu}`,background:C.blu+"22",color:C.blu,cursor:"pointer"}}>🔒</button>
                  )}
                  <button onClick={()=>toggleSkipField(f.name)} title={isSkipped?"Use this field":"Hide this field"} style={{padding:"4px 8px",fontSize:10,fontWeight:700,borderRadius:4,border:`1px solid ${isSkipped?C.ok:C.brd}`,background:isSkipped?C.ok+"22":"transparent",color:isSkipped?C.ok:C.mut,cursor:"pointer"}}>{isSkipped?"+ Show":"− Hide"}</button>
                </div>
              </div>
              {!isSkipped&&((()=>{
                const notesKw=["notes","observations","comments","description","remarks"];
                const isNotesField=notesKw.some(k=>(f.name||"").toLowerCase().includes(k));
                const isTyrActivities=isAnyTYR&&/activit/i.test(f.name||"");
                // TYR: only Daily Activities gets a textarea; everything else is single-line
                const useTextarea=isAnyTYR?isTyrActivities:(f.voiceEnabled||f.multiline||isNotesField);
                return useTextarea?(
                  <textarea value={vals[f.name]||""} onChange={e=>setVal(f.name,e.target.value)} aria-label={f.name} placeholder="Tap here and use your keyboard mic to dictate..." rows={6} style={{...fs,resize:"vertical",minHeight:140,lineHeight:1.6}}/>
                ):(
                  <input type="text" value={vals[f.name]||""} onChange={e=>setVal(f.name,e.target.value)} aria-label={f.name} placeholder={"Enter "+f.name+"..."} style={fs}/>
                );
              })())}
            </div>
            );
          })}

          {/* Bottom bar — Field Mode: Exit without saving OR Save & Exit */}
          <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"12px 20px",borderTop:`1px solid ${C.brd}`,background:C.card,zIndex:100}}>
            <div style={{maxWidth:600,margin:"0 auto",display:"flex",gap:10}}>
              {!saving&&<button onClick={()=>{reSavingRef.current=false;setSaving(false);busyRef.current=false;setSubmitting(false);onBack();}} style={{padding:"14px 16px",background:"transparent",border:`1px solid ${C.brd}`,borderRadius:10,color:C.mut,fontSize:14,fontWeight:600,cursor:"pointer"}}>Exit</button>}
              <button onClick={async()=>{await saveWorking();onBack();}} disabled={saving} style={{flex:1,padding:"14px 0",background:saving?C.brd:C.org,border:"none",borderRadius:12,color:"#fff",fontSize:15,fontWeight:700,cursor:saving?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {saving?<><span style={{display:"inline-block",width:16,height:16,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 1s linear infinite"}}/>Saving...</>:<><span>✓</span> Save & Exit</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {!fieldMode&&<div style={{maxWidth:600,margin:"0 auto",padding:"20px 20px 140px"}}>
        <div style={{fontSize:14,color:C.mut,marginBottom:6,textAlign:"center"}}>{todayDisplay}</div>
        <div style={{fontSize:11,color:C.mut,textAlign:"center",marginBottom:8}}>Editable anytime • {tz.split("/").pop().replace(/_/g," ")}</div>
        {editFilename&&(
          <div style={{marginBottom:16,padding:"8px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:11,color:C.mut,whiteSpace:"nowrap"}}>📄</span>
            <input type="text" value={editFilename} onChange={e=>{setEditFilename(e.target.value);setFilenameEdited(true);}} style={{flex:1,background:"transparent",border:"none",color:C.lt,fontSize:13,fontWeight:500,outline:"none",padding:0}} aria-label="Report filename" placeholder="Report filename"/>
            <span style={{fontSize:11,color:C.mut}}>.pdf</span>
          </div>
        )}

        {/* ── TYR: Weather Toggle ── */}
        {isAnyTYR&&(
          <div style={{...cardStyle}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:18}}>🌤</span>
                <span style={{fontSize:15,fontWeight:700,color:C.lt}}>Weather</span>
              </div>
              <button onClick={()=>toggleTyrWeather(!tyrWeatherOn)} style={{padding:"8px 18px",borderRadius:10,border:`1px solid ${tyrWeatherOn?C.ok:C.brd}`,background:tyrWeatherOn?C.ok:C.inp,color:tyrWeatherOn?"#fff":C.mut,fontSize:13,fontWeight:700,cursor:"pointer"}}>{tyrWeatherLoading?"Loading...":tyrWeatherOn?"On":"Off"}</button>
            </div>
            {tyrWeatherOn&&tyrWeather&&(
              <div style={{marginTop:10,padding:"10px 14px",background:C.inp,borderRadius:10,fontSize:14,color:C.lt,fontWeight:500}}>{tyrWeather}</div>
            )}
          </div>
        )}


        {/* ── Editable fields ── */}
        {editFields.length>0&&(
          <div style={{marginBottom:20}}>
            {/* ── Contractor Grid — card style at top (both TYR variants) ── */}
            {isAnyTYR&&(
              <div style={{...cardStyle}}>
                <button onClick={()=>setContractorsOpen(!contractorsOpen)} style={{width:"100%",background:"none",border:"none",cursor:"pointer",padding:0,textAlign:"left",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <div style={{fontSize:13,color:C.mut,fontWeight:700,display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:16}}>👷</span><span style={{letterSpacing:1}}>CONTRACTORS ON SITE</span>
                    {selectedContractors.length>0&&<span style={{fontSize:12,color:C.org,fontWeight:700,background:C.org+"18",borderRadius:12,padding:"2px 10px"}}>{selectedContractors.length}</span>}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    {selectedContractors.length>0&&!contractorsOpen&&<span style={{fontSize:10,color:C.ok,fontWeight:700,background:C.ok+"22",borderRadius:6,padding:"2px 8px"}}>SAVED</span>}
                    <span style={{fontSize:14,color:C.mut,transition:"transform 0.2s",transform:contractorsOpen?"rotate(180deg)":"rotate(0deg)"}}>▼</span>
                  </div>
                </button>
                {!contractorsOpen&&selectedContractors.length>0&&(
                  <div style={{marginTop:8,fontSize:12,color:C.mut,lineHeight:1.5}}>
                    {selectedContractors.map(c=>c.company_name+(c.manpower?" ("+c.manpower+" MP)":"")).join(", ")}
                  </div>
                )}
                {contractorsOpen&&<div style={{marginTop:14}}>
                {/* Active contractor cards */}
                {selectedContractors.length>0&&(
                  <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
                    {selectedContractors.map((sc,idx)=>(
                      <div key={sc.company_name} style={{padding:"8px 12px",borderRadius:10,background:C.card,border:`1px solid ${C.org}33`}}>
                        {/* Row 1: Number badge + Name + MP stepper + delete */}
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{width:24,height:24,borderRadius:6,background:C.org+"22",color:C.org,fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{idx+1}</div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:14,fontWeight:600,color:C.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sc.company_name}</div>
                          </div>
                          <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                            <button onClick={()=>updateContractorManpower(sc.company_name,Math.max(0,(sc.manpower||0)-1))} style={{width:28,height:28,borderRadius:6,border:`1px solid ${C.brd}`,background:C.inp,color:C.lt,fontSize:15,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>−</button>
                            <div style={{textAlign:"center",minWidth:28}}>
                              <div style={{fontSize:15,fontWeight:700,color:C.org,lineHeight:1}}>{sc.manpower||0}</div>
                              <div style={{fontSize:8,color:C.mut,marginTop:1}}>MP</div>
                            </div>
                            <button onClick={()=>updateContractorManpower(sc.company_name,(sc.manpower||0)+1)} style={{width:28,height:28,borderRadius:6,border:`1px solid ${C.brd}`,background:C.inp,color:C.lt,fontSize:15,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>+</button>
                          </div>
                          <button onClick={()=>toggleContractor(sc.company_name)} style={{background:"none",border:"none",color:C.err,fontSize:18,cursor:"pointer",padding:"4px",opacity:0.6}}>✕</button>
                        </div>
                        {/* Row 2: Equipment + Trade inputs (Original TYR only — 4-column template) */}
                        {isTYR&&(
                          <div style={{display:"flex",gap:8,marginTop:6,paddingLeft:32}}>
                            <div style={{flex:1}}>
                              <label style={{fontSize:10,fontWeight:600,color:C.mut,display:"block",marginBottom:2}}>Equipment</label>
                              <input type="text" value={sc.equipment||""} onChange={e=>updateContractorEquipment(sc.company_name,e.target.value)} placeholder="Equipment..." style={{...fs,fontSize:12,padding:"6px 8px"}}/>
                            </div>
                            <div style={{flex:1}}>
                              <label style={{fontSize:10,fontWeight:600,color:C.mut,display:"block",marginBottom:2}}>Trade</label>
                              <input type="text" value={sc.trade||""} onChange={e=>updateContractorTrade(sc.company_name,e.target.value)} placeholder="Trade..." style={{...fs,fontSize:12,padding:"6px 8px"}}/>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {/* Add contractor — pick from job list or type new */}
                {selectedContractors.length<(isTYR?3:8)&&(
                  <div style={{border:`2px dashed ${C.brd}`,borderRadius:10,padding:12}}>
                    {jobContractors.filter(jc=>!selectedContractors.find(sc=>sc.company_name===jc.company_name)).length>0&&(
                      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
                        {jobContractors.filter(jc=>!selectedContractors.find(sc=>sc.company_name===jc.company_name)).map(jc=>(
                          <button key={jc.id} onClick={()=>toggleContractor(jc.company_name)} style={{padding:"6px 14px",borderRadius:8,border:`1px solid ${C.brd}`,background:C.inp,color:C.lt,fontSize:13,fontWeight:600,cursor:"pointer"}}>+ {jc.company_name}</button>
                        ))}
                      </div>
                    )}
                    <div style={{display:"flex",gap:6}}>
                      <input type="text" id="tyrAddContractor" placeholder="New contractor name..." onKeyDown={e=>{if(e.key==="Enter"&&e.target.value.trim()){toggleContractor(e.target.value.trim());e.target.value="";}}} style={{...fs,flex:1}}/>
                      <button onClick={()=>{const el=document.getElementById("tyrAddContractor");if(el&&el.value.trim()){toggleContractor(el.value.trim());el.value="";}}} style={{padding:"10px 16px",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>Add</button>
                    </div>
                  </div>
                )}
                {selectedContractors.length>=(isTYR?3:8)&&<div style={{fontSize:11,color:C.mut,marginTop:6,textAlign:"center"}}>Maximum {isTYR?3:8} contractors ({isTYR?"3 rows":"4 per column"} on template)</div>}

                {/* ── RFIs / CCDs / ASIs / Submittals — Enhanced TYR (V5) only ── */}
                {isEnhancedTYR&&(
                <div style={{marginTop:14}}>
                  <label style={{fontSize:14,fontWeight:700,color:C.lt,marginBottom:6,display:"block"}}>RFIs / CCDs / ASIs / Submittals</label>
                  <input type="text" value={vals["RFIs/CCDs/ASIs/Submittals"]||""} onChange={e=>setVal("RFIs/CCDs/ASIs/Submittals",e.target.value)} placeholder="Separate with / for different rows..." style={{...fs}}/>
                  <div style={{fontSize:12,color:C.mut,marginTop:4}}>Use / to separate items (e.g. RFI 001 / CCD 2 / ASI 3)</div>
                </div>
                )}
                </div>}
              </div>
            )}

            {/* Regular editable fields — card wrapper */}
            <div style={{...cardStyle}}>
            {sectionLabel("📋","REPORT FIELDS")}
            {editFields.filter(f=>{
              if(f.autoFill==="date"||f.autoFill==="increment"||f.autoFill==="name")return false;
              // TYR: hide contractor/MP/manpower/RFI/equipment/trade fields — handled by dedicated sections above
              if(isAnyTYR){
                const fn=(f.name||"").toLowerCase();
                if(/contractor|^mp$|^mp[:\s]|manpower|crew\s*size|rfis|ccds|asis|submittal|equipment|trade/i.test(fn))return false;
              }
              return true;
            }).map(f=>{
              const isSkipped=skippedFields[f.name];
              // ── TYR v4: Categorize fields ──
              const fn=(f.name||"").toLowerCase();
              const isTyrReadOnly=isAnyTYR&&(/project|owner|address|general.?statement|location|site\s*address|job\s*site/i.test(fn))&&!(/activit|note|rfi|hours|weather|inspect/i.test(fn));
              const isTyrHours=isAnyTYR&&/hours|hrs/i.test(fn);
              const isTyrActivities=isAnyTYR&&/activit/i.test(fn);
              const isTyrGeneralStmt=isAnyTYR&&/general.?statement/i.test(fn);
              return(
                <div key={f.name} style={{marginBottom:isTyrReadOnly?8:14,opacity:isSkipped?0.4:1,transition:"opacity 0.2s"}}>
                  {/* ── TYR v4: Read-only project info fields ── */}
                  {isTyrReadOnly&&!isSkipped?(
                    <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0"}}>
                      <span style={{fontSize:12,color:C.mut,fontWeight:600,minWidth:90}}>{f.name}:</span>
                      <span style={{fontSize:13,color:C.lt,fontWeight:500}}>{vals[f.name]||lockVals[f.name]||f.value||"—"}</span>
                    </div>
                  ):(
                  <>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                    <label style={{fontSize:14,fontWeight:700,color:isSkipped?C.mut:C.lt}}>{f.name}{isSkipped?" — skipped":""}</label>
                    <div style={{display:"flex",gap:4,alignItems:"center"}}>
                      {f.voiceEnabled&&!isSkipped&&<span style={{fontSize:10,fontWeight:700,color:C.org,background:C.org+"22",padding:"2px 8px",borderRadius:4}}>VOICE</span>}
                      {!isSkipped&&vals[f.name]&&(
                        <button onClick={()=>relockField(f.name)} title="Lock this field with current value for all future reports" style={{padding:"6px 10px",fontSize:11,fontWeight:700,borderRadius:6,border:`1px solid ${C.blu}`,background:C.blu+"22",color:C.blu,cursor:"pointer",minHeight:32}}>🔒 Lock</button>
                      )}
                      <button onClick={()=>toggleSkipField(f.name)} title={isSkipped?"Bring back this field":"Skip this field for today"} style={{padding:"6px 10px",fontSize:11,fontWeight:700,borderRadius:6,border:`1px solid ${isSkipped?C.ok:C.brd}`,background:isSkipped?C.ok+"22":"transparent",color:isSkipped?C.ok:C.mut,cursor:"pointer",minHeight:32}}>{isSkipped?"+ Use":"− Skip"}</button>
                    </div>
                  </div>
                  {!isSkipped&&((()=>{
                    const notesKw=["notes","observations","comments","description","remarks"];
                    const isNotesField=notesKw.some(k=>fn.includes(k));
                    // TYR: only Daily Activities gets a textarea; all others are single-line inputs
                    const useTextarea=isAnyTYR?isTyrActivities:(f.voiceEnabled||f.multiline||isNotesField);
                    // TYR v4: Hours fields get inline number input
                    if(isTyrHours)return(
                      <input type="number" inputMode="decimal" value={vals[f.name]||""} onChange={e=>setVal(f.name,e.target.value)} aria-label={f.name} placeholder="0" style={{width:100,boxSizing:"border-box",padding:"10px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.lt,fontSize:15,textAlign:"center"}}/>
                    );
                    return useTextarea?(
                      <textarea value={vals[f.name]||""} onChange={e=>setVal(f.name,e.target.value)} aria-label={f.name} placeholder="Tap here and use your keyboard mic to dictate..." rows={6} style={{...fs,resize:"vertical",minHeight:140,lineHeight:1.6}}/>
                    ):(
                      <input type="text" value={vals[f.name]||""} onChange={e=>setVal(f.name,e.target.value)} aria-label={f.name} placeholder={"Enter "+f.name+"..."} style={fs}/>
                    );
                  })())}
                  </>
                  )}
                </div>
              );
            })}
          </div>
          </div>
        )}

        {editFields.length===0&&lockFields.length===0&&(
          <div style={{textAlign:"center",padding:"40px 20px",color:C.mut}}>
            <div style={{fontSize:36,marginBottom:12,color:C.brd}}>—</div>
            <p style={{fontSize:15,fontWeight:600,color:C.lt,marginBottom:6}}>No template fields configured</p>
            <p style={{fontSize:13}}>Go back and upload a template in your job settings to get started.</p>
          </div>
        )}

        {/* ── Photos — card style ── */}
        <div style={{...cardStyle}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            {sectionLabel("📷","PHOTOS",photos.length||null)}
            <div style={{display:"flex",gap:4}}>
              {layouts.map(({k,l})=>(
                <button key={k} onClick={()=>setPhotoLayout(k)} style={{padding:"6px 10px",fontSize:11,fontWeight:700,borderRadius:8,cursor:"pointer",minHeight:32,background:photoLayout===k?C.org:"transparent",border:`1px solid ${photoLayout===k?C.org:C.brd}`,color:photoLayout===k?"#fff":C.mut}}>{l}</button>
              ))}
            </div>
          </div>

          {/* Photo grid */}
          {photos.length>0&&(
            <div style={{display:"grid",gridTemplateColumns:photoLayout==="1"?"1fr":photoLayout==="2"?"1fr 1fr":"1fr 1fr",gap:10,marginBottom:14}}>
              {photos.map(p=>{const aiKey="fr-"+p.id;return(
                <div key={p.id} style={{position:"relative",borderRadius:12,overflow:"hidden",border:`1px solid ${C.brd}`,aspectRatio:photoLayout==="1"?"auto":"1"}}>
                  <img src={p.src} alt={p.name} style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
                  <button onClick={()=>setPhotos(prev=>prev.filter(x=>x.id!==p.id))} style={{position:"absolute",top:6,right:6,width:34,height:34,borderRadius:"50%",background:"rgba(0,0,0,0.7)",border:"none",color:"#fff",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                  {job.field_config?.aiPhotos&&<button disabled={aiDescribing[aiKey]||aiLimitReached} onClick={async()=>{const notesF=editFields.find(f=>f.voiceEnabled&&/notes|observations|comments/i.test(f.name));const desc=await describePhoto(p.src,`Job: ${job?.name||""}`,aiKey);if(desc&&notesF)setVals(v=>({...v,[notesF.name]:(v[notesF.name]?v[notesF.name]+"\n":"")+desc}));else if(desc)showToast("AI: "+desc.slice(0,80));}} style={{position:"absolute",bottom:6,left:6,padding:"4px 8px",borderRadius:6,background:aiLimitReached?"#666":aiDescribing[aiKey]?C.blu:C.org,border:"none",color:"#fff",fontSize:11,fontWeight:700,cursor:aiDescribing[aiKey]?"wait":aiLimitReached?"not-allowed":"pointer",opacity:aiDescribing[aiKey]||aiLimitReached?0.7:0.9}}>{aiDescribing[aiKey]?"···":aiLimitReached?"—":"AI"}</button>}
                </div>
              );})}
            </div>
          )}

          <button onClick={()=>{photoRef.current?.click();}} style={{width:"100%",padding:"18px",background:C.inp,border:`2px dashed ${C.brd}`,borderRadius:14,color:C.mut,fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
            <span style={{fontSize:28}}>📸</span>
            <span>Tap to Add Photos</span>
            <span style={{fontSize:12,color:C.mut+"99"}}>Take a photo or choose from gallery</span>
          </button>
          <input ref={photoRef} type="file" accept="image/*" multiple onChange={handlePhoto} style={{display:"none"}}/>
          <div style={{fontSize:12,color:C.mut,marginTop:8,textAlign:"center"}}>Photos display as {layouts.find(l=>l.k===photoLayout)?.l} in the final PDF</div>
        </div>

        {/* ── Auto-filled & Locked Fields — pushed to bottom, collapsible ── */}
        {(()=>{
          const autoFields=editFields.filter(f=>f.autoFill==="date"||f.autoFill==="increment"||f.autoFill==="name");
          if(autoFields.length===0&&lockFields.length===0)return null;
          const totalCount=autoFields.length+lockFields.length;
          return(
            <div style={{...cardStyle}}>
              <button onClick={()=>setAutoFilledOpen(!autoFilledOpen)} style={{width:"100%",background:"none",border:"none",cursor:"pointer",padding:0,textAlign:"left",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{fontSize:13,color:C.mut,fontWeight:700,display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:16}}>🔒</span><span style={{letterSpacing:1}}>AUTO-FILLED</span>
                  <span style={{fontSize:12,color:C.mut,fontWeight:700,background:C.inp,borderRadius:12,padding:"2px 10px"}}>{totalCount}</span>
                </div>
                <span style={{fontSize:14,color:C.mut,transition:"transform 0.2s",transform:autoFilledOpen?"rotate(180deg)":"rotate(0deg)"}}>▼</span>
              </button>
              {autoFilledOpen&&<div style={{marginTop:14}}>
              {autoFields.map((f,i)=>(
                <div key={f.name} style={{display:"flex",alignItems:"center",padding:"12px 0",borderBottom:i<autoFields.length-1||(lockFields.length>0)?`1px solid ${C.brd}`:"none"}}>
                  <span style={{fontSize:15,color:C.mut,width:110,fontWeight:600}}>{f.name}</span>
                  <span style={{fontSize:16,color:C.lt,fontWeight:600}}>{vals[f.name]||"—"}</span>
                </div>
              ))}
              {lockFields.length>0&&(
                <>
                  {lockFields.map((f,i)=>(
                    <div key={f.name} style={{display:"flex",alignItems:"center",padding:"12px 0",borderBottom:i<lockFields.length-1?`1px solid ${C.brd}`:"none"}}>
                      <span style={{fontSize:15,color:C.mut,width:110,fontWeight:600}}>{f.name}</span>
                      {lockEditing?(
                        <div style={{flex:1,display:"flex",gap:8,alignItems:"center"}}>
                          <input type="text" value={lockVals[f.name]||""} onChange={e=>setLockVal(f.name,e.target.value)} style={{...fs,flex:1,padding:"10px 12px",fontSize:14}}/>
                          <button onClick={()=>unlockField(f.name)} style={{padding:"6px 12px",fontSize:12,fontWeight:700,borderRadius:8,border:`1px solid ${C.org}`,background:"transparent",color:C.org,cursor:"pointer",whiteSpace:"nowrap"}}>Unlock</button>
                        </div>
                      ):(
                        <span style={{fontSize:16,color:C.lt,fontWeight:600}}>{lockVals[f.name]||f.value||"—"}</span>
                      )}
                    </div>
                  ))}
                  <div style={{display:"flex",justifyContent:"flex-end",marginTop:10}}>
                    {!lockEditing?(
                      <button onClick={()=>setLockEditing(true)} style={{padding:"6px 16px",fontSize:13,fontWeight:700,borderRadius:8,border:`1px solid ${C.brd}`,background:"transparent",color:C.org,cursor:"pointer"}}>Edit Locked</button>
                    ):(
                      <button onClick={saveLockEdits} style={{padding:"6px 16px",fontSize:13,fontWeight:700,borderRadius:8,border:`1px solid ${C.ok}`,background:C.ok,color:"#fff",cursor:"pointer"}}>Done</button>
                    )}
                  </div>
                </>
              )}
              </div>}
            </div>
          );
        })()}

      </div>}

      {/* Fixed bottom bar — improved */}
      {!fieldMode&&(
      <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"14px 20px 20px",borderTop:`2px solid ${C.brd}`,background:C.card,zIndex:100,boxShadow:"0 -4px 20px rgba(0,0,0,0.4)"}}>
        <div style={{maxWidth:600,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>
          <div style={{display:"flex",gap:10}}>
              <button onClick={async()=>{await saveWorking();showToast(reportStatus==="submitted"?"Changes saved":"Draft saved");}} disabled={saving||submitting||viewLoading} style={{flex:1,padding:"16px 0",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:14,color:C.lt,fontSize:15,fontWeight:700,cursor:saving?"default":"pointer",opacity:saving?0.6:1,minHeight:48}}>
                {saving?"Saving...":reportStatus==="submitted"?"Save Changes":"Save Draft"}
              </button>
            <button onClick={viewReport} disabled={viewLoading||submitting} style={{flex:1,padding:"16px 0",background:"transparent",border:`1px solid ${C.brd}`,borderRadius:14,color:C.lt,fontSize:15,fontWeight:700,cursor:viewLoading?"default":"pointer",opacity:viewLoading?0.6:1,minHeight:48}}>
              {viewLoading?"Loading...":"View Report"}
            </button>
          </div>
          <button onClick={submitReport} disabled={submitting||viewLoading} className="btn-o" style={{width:"100%",padding:"16px 0",background:`linear-gradient(135deg, ${C.org} 0%, #d4631f 100%)`,border:"none",borderRadius:14,color:"#fff",fontSize:17,fontWeight:800,cursor:submitting?"default":"pointer",opacity:submitting?0.6:1,minHeight:52,boxShadow:`0 3px 12px ${C.org}66`,letterSpacing:"0.3px"}}>
            {submitting?"Submitting...":reportStatus==="submitted"?"Update & Resubmit":"Submit Report"}
          </button>
        </div>
      </div>
      )}
    </div>
  );
}


export default ReportEditor;
