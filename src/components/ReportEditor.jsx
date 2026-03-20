import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { C } from '../constants/theme';
import { db } from '../utils/db';
import { AUTH_TOKEN, refreshAuthToken } from '../utils/auth';
import { SB_URL, SB_KEY } from '../constants/supabase';
import { ensurePdfLib, ensurePdfJs } from '../utils/pdf';
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
      const r=await fetch(`${SB_URL}/functions/v1/describe-photo`,{
        method:"POST",
        headers:{"Content-Type":"application/json",apikey:SB_KEY},
        body:JSON.stringify({image_base64:b64,context})
      });
      const data=await r.json();
      if(!r.ok)throw new Error(data.error||"AI request failed");
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
      const content={vals,lockVals,photos:safePhotos,photoLayout,lockFields,editFields,sigTimestamps};
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

  // View Report — renders original template with pdf.js, overlays field values + notes on canvas
  const viewReport=async()=>{
    if(busyRef.current)return;
    busyRef.current=true;
    setViewLoading(true);
    try{
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
        const tplBytes=new Uint8Array(await db.downloadTemplateBytes(tplRecord.storage_path));
        const tplChunks=[];for(let i=0;i<tplBytes.length;i+=8192)tplChunks.push(String.fromCharCode.apply(null,tplBytes.subarray(i,i+8192)));
        const tplB64=btoa(tplChunks.join(""));
        // Call generate-docx to fill template with field values
        const genResp=await fetch(`${SB_URL}/functions/v1/generate-docx`,{
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":"Bearer "+(AUTH_TOKEN||SB_KEY),"apikey":SB_KEY},
          body:JSON.stringify({docx_base64:tplB64,field_values:fieldValues})
        });
        if(!genResp.ok)throw new Error("Generate preview failed: "+(await genResp.text()));
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
      // Validate PDF magic bytes
      const header=new Uint8Array(tplBytes.slice(0,5));
      const headerStr=String.fromCharCode(...header);
      if(!headerStr.startsWith("%PDF")){
        throw new Error("Template file is not a valid PDF. Please re-upload a PDF template.");
      }
      await ensurePdfJs();
      if(!window.pdfjsLib)throw new Error("PDF viewer not loaded.");
      const allFields=buildEditableFields();
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
        drawFieldsOnCanvas(ctx,allFields,pi,scale,pageH);
        previewPages.push(cvs.toDataURL("image/jpeg",0.92));
        cvs.width=0;cvs.height=0;
      }
      if(isDesktop&&cleanPages.length>0){
        setEditablePreview({pages:cleanPages,fields:allFields});
      }else{
        setEditablePreview(null);
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
        const newPhotoPage=()=>{
          const cvs=document.createElement("canvas");cvs.width=pgW;cvs.height=pgH;
          const ctx=cvs.getContext("2d");
          ctx.fillStyle="#ffffff";ctx.fillRect(0,0,pgW,pgH);
          ctx.fillStyle="#666666";ctx.font=(12*scale)+"px Georgia, Cambria, serif";
          ctx.fillText("Photos — "+job.name,36*scale,40*scale);
          return {cvs,ctx};
        };
        const drawPhoto=(ctx,p,x,y,maxW,maxH)=>{
          const {im,ratio,corrW,corrH}=p;
          let imgW,imgH;
          if(ratio>=1){imgW=Math.min(maxW,maxH*ratio);imgH=imgW/ratio;}
          else{imgH=Math.min(maxH,maxW/ratio);imgW=imgH*ratio;}
          // Draw via temp canvas to ensure EXIF rotation is applied
          const tc=document.createElement("canvas");tc.width=corrW||im.naturalWidth;tc.height=corrH||im.naturalHeight;
          tc.getContext("2d").drawImage(im,0,0,tc.width,tc.height);
          ctx.drawImage(tc,x+(maxW-imgW)/2,y+(maxH-imgH)/2,imgW,imgH);
          tc.width=0;tc.height=0; // free memory
        };
        let idx=0;
        while(idx<validPhotos.length){
          if(photoLayout==="1"){
            const {cvs,ctx}=newPhotoPage();
            drawPhoto(ctx,validPhotos[idx],(pgW-Math.min(bodyW,380*scale))/2,60*scale,Math.min(bodyW,380*scale),usableHP-20*scale);
            previewPages.push(cvs.toDataURL("image/jpeg",0.92));cvs.width=0;cvs.height=0;
            idx++;
          }else if(photoLayout==="2"){
            const pair=[validPhotos[idx]];
            if(idx+1<validPhotos.length)pair.push(validPhotos[idx+1]);
            const {cvs,ctx}=newPhotoPage();
            if(pair.length===1){
              drawPhoto(ctx,pair[0],(pgW-Math.min(bodyW,380*scale))/2,60*scale,Math.min(bodyW,380*scale),usableHP-20*scale);
            }else{
              // Side-by-side — 2 columns
              const colGap=12*scale;
              const colW=(bodyW-colGap)/2;
              pair.forEach((p,c)=>{
                drawPhoto(ctx,p,36*scale+c*(colW+colGap),60*scale,colW,usableHP-20*scale);
              });
            }
            previewPages.push(cvs.toDataURL("image/jpeg",0.92));cvs.width=0;cvs.height=0;
            idx+=pair.length;
          }else{
            // 4 per page — 2x2 grid
            const chunk=validPhotos.slice(idx,idx+4);
            const {cvs,ctx}=newPhotoPage();
            const slotW=(bodyW-12*scale)/2;const slotH=(usableHP-20*scale-12*scale)/2;
            chunk.forEach((p,ci)=>{
              const col=ci%2;const row=Math.floor(ci/2);
              drawPhoto(ctx,p,36*scale+col*(slotW+12*scale),60*scale+row*(slotH+12*scale),slotW,slotH);
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

      // ── 1. Look up template ──
      const tplRecord=await db.getTemplate(job.id);
      if(!tplRecord){console.error("Submit: no template record for job:",job.id);throw new Error("No template record found. Go to Job Settings and re-upload your template.");}
      if(!tplRecord.storage_path){console.error("Submit: template has no storage_path:",JSON.stringify(tplRecord));throw new Error("Template file is missing. Go to Job Settings and re-upload your template.");}
      const tplBytes=await db.downloadTemplateBytes(tplRecord.storage_path);
      const isPdfTemplate=tplRecord.file_type==="pdf";
      const isDocxTemplate=tplRecord.file_type==="docx"||tplRecord.file_type==="doc";

      // ── DOCX path: send to edge function for XML editing ──
      setSubmitStep("Generating report...");
      if(isDocxTemplate){
        const allFields=buildEditableFields();
        const fieldValues={};
        allFields.forEach(f=>{if(f.val)fieldValues[f.name]=f.val;});
        // Convert template to base64
        const tplUint8=new Uint8Array(tplBytes);
        const tplChunks=[];for(let i=0;i<tplUint8.length;i+=8192)tplChunks.push(String.fromCharCode.apply(null,tplUint8.subarray(i,i+8192)));
        const tplB64=btoa(tplChunks.join(""));
        // Call generate-docx edge function
        const genResp=await fetch(`${SB_URL}/functions/v1/generate-docx`,{
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":"Bearer "+(AUTH_TOKEN||SB_KEY),"apikey":SB_KEY},
          body:JSON.stringify({docx_base64:tplB64,field_values:fieldValues})
        });
        if(!genResp.ok)throw new Error("Generate DOCX failed: "+(await genResp.text()));
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
        let upR=await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${storagePath}`,{
          method:"POST",headers:{apikey:SB_KEY,Authorization:`Bearer ${AUTH_TOKEN||SB_KEY}`,"Content-Type":"application/octet-stream"},body:docxBlob
        });
        if(!upR.ok){upR=await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${storagePath}`,{
          method:"PUT",headers:{apikey:SB_KEY,Authorization:`Bearer ${AUTH_TOKEN||SB_KEY}`,"Content-Type":"application/octet-stream"},body:docxBlob
        });}
        if(!upR.ok)throw new Error("File upload failed ("+upR.status+"). Report was NOT submitted.");
        const reportContent={vals,lockVals,photos:[],photoLayout:"1",lockFields:[],editFields:allFields};
        await db.saveReport({job_id:job.id,user_id:user.id,report_date:submitDate,status:"submitted",content:JSON.stringify(reportContent),updated_at:new Date().toISOString()});
        const userName=user.user_metadata?.full_name||user.email?.split("@")[0]||"Inspector";
        const emailHtml=`<div style="font-family:-apple-system,sans-serif;max-width:600px;"><div style="background:#e8742a;padding:20px 24px;border-radius:8px 8px 0 0;"><h1 style="color:#fff;margin:0;font-size:20px;">My Daily Reports</h1></div><div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;"><p style="color:#333;font-size:16px;">${userName} has submitted the daily report for <strong>${job.name}</strong> on ${todayDisplay}.</p><p style="color:#555;font-size:14px;">The filled DOCX report is attached.</p></div></div>`;
        const rawTeam=job.team_emails||[];
        const teamEmails=rawTeam.map(m=>typeof m==="string"?m:m.email).filter(Boolean);
        setSubmitSuccess({pdfBlob:docxBlob,pdfFilename:docxFilename,pdfBase64:docxBase64,emailHtml,teamEmails,jobName:job.name,todayDisplay,userName});
        return;
      }

      // ── 2. Build field values ──
      const allFields=buildEditableFields();
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
      const fontItalic=await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
      const pages=pdfDoc.getPages();

      // ── 3. Fill fields by coordinates (standard path — skip for AcroForm fill-by-name) ──
      if(fcSource!=="acroform"){
      // Use drawText directly — no AcroForm create+flatten (which adds white backgrounds over colored cells)
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
            // Signature: place ABOVE the signature line (line is at bottom of field area)
            const sigSz=sz*0.85;
            const sigBlockH=sigSz*2.8; // total height of 3-line signature block
            const pdfY=pageH-f.y-fieldH+sigBlockH+sigSz*0.3; // position so sig block sits above the line
            const sigTime=sigTimestamps[f.name]?new Date(sigTimestamps[f.name]):new Date();
            const dayName=sigTime.toLocaleDateString("en-US",{weekday:"long"});
            const datePart=sigTime.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
            const timePart=sigTime.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true});
            page.drawText("Signed by "+String(f.val),{x:f.x+2,y:pdfY,size:sigSz,font:fontItalic,color:rgb(0.1,0.1,0.1)});
            page.drawText(dayName+", "+datePart+" at "+timePart,{x:f.x+2,y:pdfY-sigSz*1.15,size:sigSz*0.65,font,color:rgb(0.4,0.4,0.4)});
            page.drawText("powered by My Daily Reports",{x:f.x+2,y:pdfY-sigSz*2.1,size:sigSz*0.55,font:fontItalic,color:rgb(0.6,0.6,0.6)});
          }else if(f.multiline&&f.w){
            // Multiline: bullet-formatted with hanging indent, start at TOP of field, clip at bottom
            const leftPad=6; // indent from left edge of field
            const fieldTopPDF=pageH-f.y;
            const fieldBottomPDF=pageH-f.y-fieldH;
            const textStartY=fieldTopPDF-sz; // first baseline just below top edge
            const maxW=f.w-leftPad-4;const rawLines=f.val.split(/\n/).filter(l=>l.trim());
            const useBullets=rawLines.length>1;
            const bullet="\u2022  ";
            const bulletW=useBullets?font.widthOfTextAtSize(bullet,sz):0;
            const textAfterBullet=leftPad+bulletW; // x offset where text starts after bullet
            const wrapMaxW=maxW-bulletW; // wrap width for continuation lines
            // Build lines: {text, xOffset, newBullet} — bullet lines start at leftPad, continuations at textAfterBullet
            const lines=[];
            rawLines.forEach(rl=>{
              const clean=rl.replace(/^[\-\•\*]\s*/,"").trim();
              if(!clean)return;
              const words=clean.split(" ");let cur="";let first=true;
              words.forEach(w=>{const test=cur?cur+" "+w:w;const tw=font.widthOfTextAtSize(test,sz);if(tw>wrapMaxW&&cur){lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});first=false;cur=w;}else cur=test;});
              if(cur)lines.push({text:first?(useBullets?bullet:"")+cur:cur,xOff:first?leftPad:textAfterBullet,newBullet:first});
            });
            // Only draw lines that fit within the field boundary — 1.5x within bullets, 2x between bullets
            let yOff=0;lines.forEach((ln,i)=>{if(i>0)yOff+=(ln.newBullet&&useBullets)?sz*2:sz*1.5;const ly=textStartY-yOff;if(ly>=fieldBottomPDF)page.drawText(ln.text,{x:f.x+ln.xOff,y:ly,size:sz,font,color:rgb(0,0,0)});});
          }else{
            // Single line: vertically center text in the cell, auto-shrink if too wide
            let useSz=sz;
            const fieldW=f.w||120;
            if(fieldW>0){const tw=font.widthOfTextAtSize(String(f.val),useSz);if(tw>fieldW-4){useSz=Math.max(6,useSz*(fieldW-4)/tw);}}
            const pdfY=pageH-f.y-(fieldH+useSz)/2+useSz*0.15;
            page.drawText(String(f.val),{x:f.x+2,y:pdfY,size:useSz,font,color:rgb(0,0,0)});
          }
        });
      }
      } // end if !acroform

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
        if(p1Fields.length>0){
          headerBottomTL=Math.max(Math.min(...p1Fields.map(f=>f.y))-5,0);
          footerTopTL=Math.min(Math.max(...p1Fields.map(f=>f.y+(f.h||12)))+5,pageH);
        }
        // Convert to PDF coords (bottom-left origin)
        const headerBottomPDF=pageH-headerBottomTL; // PDF y where header ends
        const footerTopPDF=pageH-footerTopTL; // PDF y where footer starts

        // Embed header and footer as clipped regions from the template's first page
        let headerEmbed=null,footerEmbed=null;
        const headerH=pageH-headerBottomPDF>10?(pageH-headerBottomPDF):0;
        const footerH=footerTopPDF>10?footerTopPDF:0;
        if(srcDoc&&headerH>0){
          const srcPage=srcDoc.getPage(0);
          headerEmbed=await pdfDoc.embedPage(srcPage,{left:0,right:pageW,bottom:headerBottomPDF,top:pageH});
        }
        if(srcDoc&&footerH>0){
          const srcPage=srcDoc.getPage(0);
          footerEmbed=await pdfDoc.embedPage(srcPage,{left:0,right:pageW,bottom:0,top:footerTopPDF});
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

        const addPhotoPage=()=>{
          const np=pdfDoc.addPage([pageW,pageH]);
          if(headerEmbed)np.drawPage(headerEmbed,{x:0,y:headerBottomPDF,width:pageW,height:headerH});
          if(footerEmbed)np.drawPage(footerEmbed,{x:0,y:0,width:pageW,height:footerTopPDF});
          return np;
        };

        // Helper: draw caption text centered below an image
        const drawCaption=(pg,caption,imgX,imgY,imgW)=>{
          if(!caption)return;
          const maxCaptionW=imgW+40;
          // Truncate if too long
          let txt=caption.length>120?caption.slice(0,117)+"...":caption;
          const tw=captionFont.widthOfTextAtSize(txt,captionSize);
          const cx=imgX+(imgW-Math.min(tw,maxCaptionW))/2;
          pg.drawText(txt,{x:Math.max(36,cx),y:imgY-captionSize-4,size:captionSize,font:captionFont,color:rgb(0.3,0.3,0.3),maxWidth:maxCaptionW});
        };

        for(let i=0;i<embeddedPhotos.length;){
          if(photoLayout==="1"){
            // 1 per page — centered
            const pg=addPhotoPage();
            const {img,ratio,caption}=embeddedPhotos[i];
            const capH=caption?captionSize+8:0;
            const maxW=Math.min(bodyW,380);const maxH=usableH-20-capH;
            let imgW,imgH;
            if(ratio>=1){imgW=Math.min(maxW,maxH*ratio);imgH=imgW/ratio;}
            else{imgH=Math.min(maxH,maxW/ratio);imgW=imgH*ratio;}
            const imgX=(pageW-imgW)/2;
            const imgY=photoAreaTop-10-imgH+(usableH-20-capH-imgH)/2+capH;
            pg.drawImage(img,{x:imgX,y:imgY,width:imgW,height:imgH});
            drawCaption(pg,caption,imgX,imgY,imgW);
            i++;
          }else if(photoLayout==="2"){
            // Smart 2-per-page: detect orientation for layout
            const pair=[embeddedPhotos[i]];
            if(i+1<embeddedPhotos.length)pair.push(embeddedPhotos[i+1]);
            const pg=addPhotoPage();
            if(pair.length===1){
              // Single remaining photo — center it
              const {img,ratio}=pair[0];
              const maxW=Math.min(bodyW,380);const maxH=usableH-20;
              let imgW,imgH;
              if(ratio>=1){imgW=Math.min(maxW,maxH*ratio);imgH=imgW/ratio;}
              else{imgH=Math.min(maxH,maxW/ratio);imgW=imgH*ratio;}
              pg.drawImage(img,{x:(pageW-imgW)/2,y:photoAreaTop-10-imgH+(usableH-20-imgH)/2,width:imgW,height:imgH});
            }else{
              // Side-by-side — 2 columns
              const colGap=12;
              const colW=(bodyW-colGap)/2;
              const maxH=usableH-20;
              pair.forEach((p,c)=>{
                const {img,ratio,caption}=p;
                const capH=caption?captionSize+8:0;
                let imgW,imgH;
                if(ratio>=1){imgW=Math.min(colW,maxH*ratio);imgH=imgW/ratio;}
                else{imgH=Math.min(maxH-capH,(colW)/ratio);imgW=imgH*ratio;}
                if(imgW>colW){imgH=imgH*(colW/imgW);imgW=colW;}
                if(imgH>maxH-capH){imgW=imgW*((maxH-capH)/imgH);imgH=maxH-capH;}
                const xPos=36+c*(colW+colGap)+(colW-imgW)/2;
                const yPos=photoAreaTop-10-imgH+(maxH-capH-imgH)/2+capH;
                pg.drawImage(img,{x:xPos,y:Math.max(yPos,photoAreaBottom),width:imgW,height:imgH});
                drawCaption(pg,caption,xPos,Math.max(yPos,photoAreaBottom),imgW);
              });
            }
            i+=pair.length;
          }else{
            // 4 per page — 2x2 grid
            const cols=2;const rows=2;
            const chunk=embeddedPhotos.slice(i,i+4);
            const pg=addPhotoPage();
            const slotW=(bodyW-12)/cols;const slotH=(usableH-20-12)/rows;
            chunk.forEach((p,idx)=>{
              const {img,ratio}=p;
              let imgW,imgH;
              if(ratio>=1){imgW=Math.min(slotW,slotH*ratio);imgH=imgW/ratio;}
              else{imgH=Math.min(slotH,slotW/ratio);imgW=imgH*ratio;}
              const col=idx%cols;const row=Math.floor(idx/cols);
              const slotX=36+col*(slotW+12);
              const rowTop=photoAreaTop-10-(row*(slotH+12));
              const xPos=slotX+(slotW-imgW)/2;
              const yPos=rowTop-imgH+(slotH-imgH)/2;
              pg.drawImage(img,{x:xPos,y:Math.max(yPos,photoAreaBottom),width:imgW,height:imgH});
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
      let upR=await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${storagePath}`,{
        method:"POST",headers:{apikey:SB_KEY,Authorization:`Bearer ${AUTH_TOKEN||SB_KEY}`,"Content-Type":"application/pdf"},body:pdfBlob
      });
      if(!upR.ok){upR=await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${storagePath}`,{
        method:"PUT",headers:{apikey:SB_KEY,Authorization:`Bearer ${AUTH_TOKEN||SB_KEY}`,"Content-Type":"application/pdf"},body:pdfBlob
      });}
      if(!upR.ok)throw new Error("File upload failed ("+upR.status+"). Report was NOT submitted.");

      setSubmitStep("Saving report...");
      const reportContent={vals,lockVals,photos,photoLayout,lockFields,editFields};
      await db.saveReport({
        job_id:job.id,user_id:user.id,report_date:submitDate,status:"submitted",
        content:JSON.stringify(reportContent),updated_at:new Date().toISOString()
      });

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
      showToast("Submit failed: "+e.message);
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
  const emailToTeam=async()=>{
    if(!submitSuccess)return;
    setEmailing(true);
    try{
      const userEmail=user.email;
      const recipients=[...new Set([userEmail,...submitSuccess.teamEmails])].filter(Boolean);
      if(recipients.length===0){showToast("No team emails configured. Add them in Job Settings.");setEmailing(false);return;}
      // Get company name for dynamic sender
      let senderName="My Daily Reports";
      try{const prof=await db.getProfile(user.id);if(prof?.company_name)senderName=prof.company_name;}catch(e){}
      await refreshAuthToken();
      if(!AUTH_TOKEN)throw new Error("Session expired. Please sign out and back in.");
      const emailBody=JSON.stringify({to:recipients,subject:`${submitSuccess.jobName} — Daily Report ${submitSuccess.todayDisplay}`,html_body:submitSuccess.emailHtml,pdf_base64:submitSuccess.pdfBase64,pdf_filename:submitSuccess.pdfFilename,sender_name:senderName});
      let r=await fetch(`${SB_URL}/functions/v1/send-report`,{
        method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${AUTH_TOKEN}`,apikey:SB_KEY},body:emailBody
      });
      // Only retry on 401 if the response is NOT from our function (Supabase gateway auth failure)
      if(r.status===401){const peek=await r.clone().text().catch(()=>"");const isGateway=!peek.includes("Resend");if(isGateway){await refreshAuthToken();if(!AUTH_TOKEN)throw new Error("Session expired. Please sign out and back in.");r=await fetch(`${SB_URL}/functions/v1/send-report`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${AUTH_TOKEN}`,apikey:SB_KEY},body:emailBody});}}
      if(!r.ok){const errText=await r.text().catch(()=>"");let errMsg=`Email send failed (${r.status})`;try{const errBody=JSON.parse(errText);errMsg=errBody.error||errMsg;console.error("Email API:",r.status,errBody);}catch(pe){console.error("Email API (raw):",r.status,errText);if(errText)errMsg=errText.slice(0,200);}throw new Error(errMsg);}
      showToast("Report emailed to "+recipients.length+" recipient"+(recipients.length>1?"s":"")+"!");
    }catch(e){
      console.error("Email error:",e);
      const msg=e.message||"Unknown error";
      if(msg.includes("RESEND_API_KEY"))showToast("Email not configured: Set RESEND_API_KEY in Supabase secrets.");
      else if(msg.includes("404")||msg.includes("FunctionNotFound"))showToast("Email function not deployed. Deploy with: npx supabase functions deploy send-report");
      else if(msg.includes("validation_error")||msg.includes("not verified"))showToast("Email domain not verified in Resend.");
      else if(msg.includes("Resend API error"))showToast("Email service error: "+msg.replace("Resend API error ","").slice(0,150));
      else showToast("Email failed: "+msg);
    }finally{setEmailing(false);}
  };

  const fs={width:"100%",padding:"12px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15};
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
          <button onClick={async()=>{closeCamera();if(reportStatus!=="submitted")await saveWorking();setViewingReport(null);setViewDocxHtml(null);setEditablePreview(null);onBack();}} disabled={saving} style={{flex:1,padding:"14px 0",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15,fontWeight:700,cursor:"pointer",opacity:saving?0.5:1}}>
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
            <button onClick={emailToTeam} disabled={emailing} style={{width:"100%",padding:"16px 20px",background:C.org,border:"none",borderRadius:12,color:"#fff",fontSize:15,fontWeight:700,cursor:emailing?"default":"pointer",opacity:emailing?0.7:1,display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:22}}>✉</span>
              <div style={{textAlign:"left"}}>
                <div>{emailing?"Sending...":"Email to Project Team"}</div>
                <div style={{fontSize:11,fontWeight:400,opacity:0.8}}>
                  {emailing?"Emails may take up to 5 minutes to arrive. Do not resend."
                    :teamCount>0
                    ?`Send to ${teamCount+1} recipient${teamCount+1>1?"s":""} (you + ${teamCount} team)`
                    :user.email?"Send to "+user.email:"No team emails configured"}
                </div>
              </div>
            </button>

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
        <button onClick={async()=>{closeCamera();if(reportStatus!=="submitted")await saveWorking();onBack();}} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
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
          {editFields.filter(f=>!(f.autoFill==="date"||f.autoFill==="increment"||f.autoFill==="name")).map(f=>{
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
                const useTextarea=f.voiceEnabled||f.multiline||isNotesField;
                return useTextarea?(
                  <textarea value={vals[f.name]||""} onChange={e=>setVal(f.name,e.target.value)} aria-label={f.name} placeholder="Tap here and use your keyboard mic to dictate..." rows={10} style={{width:"100%",boxSizing:"border-box",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,padding:"14px 16px",fontSize:15,color:C.lt,resize:"vertical",minHeight:250,lineHeight:1.6,fontFamily:"inherit"}}/>
                ):(
                  <input type="text" value={vals[f.name]||""} onChange={e=>setVal(f.name,e.target.value)} aria-label={f.name} placeholder={"Enter "+f.name+"..."} style={{width:"100%",boxSizing:"border-box",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,padding:"12px 14px",fontSize:15,color:C.lt}}/>
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

        {/* ── Locked Fields (collapsible) ── */}
        {lockFields.length>0&&(
          <div style={{marginBottom:16}}>
            <button type="button" aria-expanded={showLocked} onClick={()=>setShowLocked(!showLocked)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"14px 16px",background:C.card,border:`1px solid ${C.brd}`,borderRadius:showLocked?"12px 12px 0 0":12,cursor:"pointer",textAlign:"left"}}>
              <span style={{fontSize:16}}>🔒</span>
              <span style={{flex:1,fontWeight:700,fontSize:14,color:C.mut}}>Locked Fields</span>
              <span style={{fontSize:12,color:C.mut,background:C.inp,borderRadius:10,padding:"2px 10px",marginRight:6}}>{lockFields.length}</span>
              <span style={{color:C.mut,fontSize:12,transform:showLocked?"rotate(180deg)":"none",transition:"transform 0.2s"}}>▼</span>
            </button>
            {showLocked&&(
              <div style={{background:C.card,border:`1px solid ${C.brd}`,borderTop:"none",borderRadius:"0 0 12px 12px",padding:"8px 16px 14px"}}>
                {/* Edit toggle */}
                <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
                  {!lockEditing?(
                    <button onClick={()=>setLockEditing(true)} style={{padding:"4px 12px",fontSize:12,fontWeight:700,borderRadius:6,border:`1px solid ${C.brd}`,background:"transparent",color:C.org,cursor:"pointer"}}>Edit</button>
                  ):(
                    <button onClick={saveLockEdits} style={{padding:"4px 12px",fontSize:12,fontWeight:700,borderRadius:6,border:`1px solid ${C.ok}`,background:C.ok,color:"#fff",cursor:"pointer"}}>Done</button>
                  )}
                </div>
                {lockFields.map((f,i)=>(
                  <div key={f.name} style={{padding:"8px 0",borderBottom:i<lockFields.length-1?`1px solid ${C.brd}`:"none"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:lockEditing?8:0}}>
                      <span style={{fontSize:13,color:C.mut}}>{f.name}</span>
                      {!lockEditing&&<span style={{fontSize:13,fontWeight:600,color:C.lt}}>{lockVals[f.name]||f.value||"—"}</span>}
                    </div>
                    {lockEditing&&(
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        <input type="text" value={lockVals[f.name]||""} onChange={e=>setLockVal(f.name,e.target.value)} style={{...fs,flex:1,padding:"8px 10px",fontSize:13}}/>
                        <button onClick={()=>unlockField(f.name)} title="Permanently unlock this field" style={{padding:"6px 12px",fontSize:11,fontWeight:700,borderRadius:6,border:`1px solid ${C.org}`,background:"transparent",color:C.org,cursor:"pointer",whiteSpace:"nowrap",minHeight:32}}>Unlock</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Editable fields ── */}
        {editFields.length>0&&(
          <div style={{marginBottom:20}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
              <div style={{fontSize:12,fontWeight:700,color:C.org,textTransform:"uppercase",letterSpacing:1}}>Fill In Today</div>
              {editFields.filter(f=>!f.autoFill&&vals[f.name]).length>1&&(
                <button onClick={async()=>{const toLock=editFields.filter(f=>!f.autoFill&&vals[f.name]&&!skippedFields[f.name]);if(toLock.length===0)return;if(!await askConfirm("Lock "+toLock.length+" filled field"+(toLock.length!==1?"s":"")+"? They'll keep their current values for all future reports."))return;toLock.forEach(f=>relockField(f.name));}} style={{padding:"6px 12px",fontSize:11,fontWeight:700,borderRadius:6,border:`1px solid ${C.blu}`,background:C.blu+"22",color:C.blu,cursor:"pointer",minHeight:32}}>🔒 Lock All Filled</button>
              )}
            </div>
            {/* Auto-fill fields (Date, Report #, Name) — compact inline row */}
            {(()=>{
              const autoFields=editFields.filter(f=>f.autoFill==="date"||f.autoFill==="increment"||f.autoFill==="name");
              if(autoFields.length===0)return null;
              return(
                <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:14,padding:"10px 14px",background:C.inp,borderRadius:10,border:`1px solid ${C.brd}`}}>
                  {autoFields.map(f=>(
                    <div key={f.name} style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontSize:11,color:C.mut,fontWeight:600}}>{f.name}:</span>
                      <span style={{fontSize:13,color:C.lt,fontWeight:600}}>{vals[f.name]||"—"}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
            {/* Regular editable fields */}
            {editFields.filter(f=>!(f.autoFill==="date"||f.autoFill==="increment"||f.autoFill==="name")).map(f=>{
              const isSkipped=skippedFields[f.name];
              return(
                <div key={f.name} style={{marginBottom:14,opacity:isSkipped?0.4:1,transition:"opacity 0.2s"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                    <label style={{fontSize:13,fontWeight:600,color:isSkipped?C.mut:C.lt}}>{f.name}{isSkipped?" — skipped":""}</label>
                    <div style={{display:"flex",gap:4,alignItems:"center"}}>
                      {f.voiceEnabled&&!isSkipped&&<span style={{fontSize:10,fontWeight:700,color:C.org,background:C.org+"22",padding:"2px 8px",borderRadius:4}}>VOICE</span>}
                      {!isSkipped&&vals[f.name]&&(
                        <button onClick={()=>relockField(f.name)} title="Lock this field with current value for all future reports" style={{padding:"6px 10px",fontSize:11,fontWeight:700,borderRadius:6,border:`1px solid ${C.blu}`,background:C.blu+"22",color:C.blu,cursor:"pointer",minHeight:32}}>🔒 Lock</button>
                      )}
                      <button onClick={()=>toggleSkipField(f.name)} title={isSkipped?"Bring back this field":"Skip this field for today"} style={{padding:"6px 10px",fontSize:11,fontWeight:700,borderRadius:6,border:`1px solid ${isSkipped?C.ok:C.brd}`,background:isSkipped?C.ok+"22":"transparent",color:isSkipped?C.ok:C.mut,cursor:"pointer",minHeight:32}}>{isSkipped?"+ Use":"− Skip"}</button>
                    </div>
                  </div>
                  {!isSkipped&&((()=>{
                    // HARD RULE: notes/observations/comments fields ALWAYS render as a large textarea, never a single-line input
                    const notesKw=["notes","observations","comments","description","remarks"];
                    const isNotesField=notesKw.some(k=>(f.name||"").toLowerCase().includes(k));
                    const useTextarea=f.voiceEnabled||f.multiline||isNotesField;
                    return useTextarea?(
                      <textarea value={vals[f.name]||""} onChange={e=>setVal(f.name,e.target.value)} aria-label={f.name} placeholder="Tap here and use your keyboard mic to dictate..." rows={10} style={{width:"100%",boxSizing:"border-box",padding:"14px 16px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15,resize:"vertical",minHeight:250,lineHeight:1.6,fontFamily:"inherit"}}/>
                    ):(
                      <input type="text" value={vals[f.name]||""} onChange={e=>setVal(f.name,e.target.value)} aria-label={f.name} placeholder={"Enter "+f.name+"..."} style={fs}/>
                    );
                  })())}
                </div>
              );
            })}
          </div>
        )}

        {editFields.length===0&&lockFields.length===0&&(
          <div style={{textAlign:"center",padding:"40px 20px",color:C.mut}}>
            <div style={{fontSize:36,marginBottom:12,color:C.brd}}>—</div>
            <p style={{fontSize:15,fontWeight:600,color:C.lt,marginBottom:6}}>No template fields configured</p>
            <p style={{fontSize:13}}>Go back and upload a template in your job settings to get started.</p>
          </div>
        )}

        {/* ── Photos ── */}
        <div style={{marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div style={{fontSize:12,fontWeight:700,color:C.org,textTransform:"uppercase",letterSpacing:1}}>Photos</div>
            <div style={{display:"flex",gap:4}}>
              {layouts.map(({k,l})=>(
                <button key={k} onClick={()=>setPhotoLayout(k)} style={{padding:"6px 10px",fontSize:11,fontWeight:700,borderRadius:6,cursor:"pointer",minHeight:32,background:photoLayout===k?C.org:"transparent",border:`1px solid ${photoLayout===k?C.org:C.brd}`,color:photoLayout===k?"#fff":C.mut}}>{l}</button>
              ))}
            </div>
          </div>

          {/* Photo grid */}
          {photos.length>0&&(
            <div style={{display:"grid",gridTemplateColumns:photoLayout==="1"?"1fr":photoLayout==="2"?"1fr 1fr":"1fr 1fr",gap:8,marginBottom:12}}>
              {photos.map(p=>{const aiKey="fr-"+p.id;return(
                <div key={p.id} style={{position:"relative",borderRadius:8,overflow:"hidden",border:`1px solid ${C.brd}`,aspectRatio:photoLayout==="1"?"auto":"1"}}>
                  <img src={p.src} alt={p.name} style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
                  <button onClick={()=>setPhotos(prev=>prev.filter(x=>x.id!==p.id))} style={{position:"absolute",top:4,right:4,width:32,height:32,borderRadius:"50%",background:"rgba(0,0,0,0.7)",border:"none",color:"#fff",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                  {job.field_config?.aiPhotos&&<button disabled={aiDescribing[aiKey]||aiLimitReached} onClick={async()=>{const notesF=editFields.find(f=>f.voiceEnabled&&/notes|observations|comments/i.test(f.name));const desc=await describePhoto(p.src,`Job: ${job?.name||""}`,aiKey);if(desc&&notesF)setVals(v=>({...v,[notesF.name]:(v[notesF.name]?v[notesF.name]+"\n":"")+desc}));else if(desc)showToast("AI: "+desc.slice(0,80));}} style={{position:"absolute",bottom:4,left:4,padding:"3px 7px",borderRadius:5,background:aiLimitReached?"#666":aiDescribing[aiKey]?C.blu:C.org,border:"none",color:"#fff",fontSize:10,fontWeight:700,cursor:aiDescribing[aiKey]?"wait":aiLimitReached?"not-allowed":"pointer",opacity:aiDescribing[aiKey]||aiLimitReached?0.7:0.9}}>{aiDescribing[aiKey]?"···":aiLimitReached?"—":"AI"}</button>}
                </div>
              );})}
            </div>
          )}

          {/* Two photo buttons */}
          <div style={{display:"flex",gap:10}}>
            <button onClick={()=>{photoRef.current?.click();}} style={{flex:1,padding:"14px 0",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,color:C.lt,fontSize:14,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              <span>📷</span> Add Photo
            </button>
          </div>
          <input ref={photoRef} type="file" accept="image/*" multiple onChange={handlePhoto} style={{display:"none"}}/>
          <div style={{fontSize:11,color:C.mut,marginTop:8}}>Photos will display as {layouts.find(l=>l.k===photoLayout)?.l} in the final PDF</div>
        </div>

      </div>}

      {/* Fixed bottom bar */}
      {!fieldMode&&(
      <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"12px 20px",borderTop:`1px solid ${C.brd}`,background:C.card,zIndex:100}}>
        <div style={{maxWidth:600,margin:"0 auto",display:"flex",flexDirection:"column",gap:8}}>
          <div style={{display:"flex",gap:10}}>
            {reportStatus!=="submitted"&&(
              <button onClick={async()=>{await saveWorking();showToast("Draft saved");}} disabled={saving||submitting||viewLoading} style={{flex:1,padding:"14px 0",background:C.blu,border:"none",borderRadius:10,color:"#fff",fontSize:14,fontWeight:700,cursor:saving?"default":"pointer",opacity:saving?0.6:1,minHeight:44}}>
                {saving?"Saving...":"Save Draft"}
              </button>
            )}
            <button onClick={viewReport} disabled={viewLoading||submitting} style={{flex:1,padding:"14px 0",background:"transparent",border:`1px solid ${C.brd}`,borderRadius:10,color:C.lt,fontSize:14,fontWeight:700,cursor:viewLoading?"default":"pointer",opacity:viewLoading?0.6:1,minHeight:44}}>
              {viewLoading?"Loading...":"View Report"}
            </button>
          </div>
          <button onClick={submitReport} disabled={submitting||viewLoading} className="btn-o" style={{width:"100%",padding:"14px 0",background:C.org,border:"none",borderRadius:10,color:"#fff",fontSize:15,fontWeight:700,cursor:submitting?"default":"pointer",opacity:submitting?0.6:1,minHeight:44}}>
            {submitting?"Submitting...":reportStatus==="submitted"?"Update & Resubmit":"Submit Report"}
          </button>
        </div>
      </div>
      )}
    </div>
  );
}


export default ReportEditor;
