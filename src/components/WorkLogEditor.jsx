import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { C } from '../constants/theme';
import { db } from '../utils/db';
import { AUTH_TOKEN, refreshAuthToken } from '../utils/auth';
import { api } from '../utils/api';
import { SB_URL, SB_KEY } from '../constants/supabase';
import { ensurePdfLib, ensurePdfJs } from '../utils/pdf';
import { AI_DESCRIBE_DAILY_LIMIT, getAiUsageCount, checkAiLimit, incrementAiUsage } from '../utils/ai-usage';
import { askConfirm } from './ConfirmOverlay';

function WorkLogEditor({job, user, onBack, reportDate}){
  const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayISO=reportDate||new Date().toLocaleDateString("en-CA",{timeZone:tz});
  const [contractors,setContractors]=useState([]); // [{id,name,description,hours,quantity,photos:[]}]
  const [activeId,setActiveId]=useState(null); // expanded contractor id
  const [showAdd,setShowAdd]=useState(false);
  const [newName,setNewName]=useState("");
  const [fieldMode,setFieldMode]=useState(false);
  const [fieldAddName,setFieldAddName]=useState("");
  const [saving,setSaving]=useState(false);
  const [submitting,setSubmitting]=useState(false);
  const [wlSubmitStep,setWlSubmitStep]=useState("");
  const [viewingPreview,setViewingPreview]=useState(null); // array of page data URLs for preview
  const [viewLoading,setViewLoading]=useState(false);
  const [draftId,setDraftId]=useState(null);
  const [wlReportStatus,setWlReportStatus]=useState(null);
  const [generalNotes,setGeneralNotes]=useState("");
  const [safetyNotes,setSafetyNotes]=useState("");
  const [materials,setMaterials]=useState("");
  const [equipment,setEquipment]=useState("");
  const [qualityControl,setQualityControl]=useState("");
  const [customCategories,setCustomCategories]=useState([]); // [{title:"",value:""}]
  const [survey,setSurvey]=useState([
    {q:"Any accidents on site today?",answer:"",desc:""},
    {q:"Any schedule delays occur?",answer:"",desc:""},
    {q:"Did weather cause any delays?",answer:"",desc:""},
    {q:"Any visitors on site?",answer:"",desc:""},
    {q:"Any areas that can't be worked on?",answer:"",desc:""},
    {q:"Any equipment rented on site?",answer:"",desc:""}
  ]);
  const [expandedSections,setExpandedSections]=useState({});
  const toggleSection=(key)=>setExpandedSections(p=>({...p,[key]:!p[key]}));
  const [weatherEnabled,setWeatherEnabled]=useState(false); // opt-in weather display
  const [weatherAM,setWeatherAM]=useState("");
  const [weatherMid,setWeatherMid]=useState("");
  const [weatherPM,setWeatherPM]=useState("");
  const photoRef=useRef(null);
  const [photoTarget,setPhotoTarget]=useState(null); // contractor id for photo upload
  const [photoMode,setPhotoMode]=useState(null); // "camera" or "library"
  const [sectionPhotos,setSectionPhotos]=useState({}); // {materials:[{data,name,ts}], ...}
  const [sectionCarry,setSectionCarry]=useState({}); // {materials:true, equipment:false, ...} — carry over toggle per section
  const sectionPhotoRef=useRef(null);
  const sectionLibraryRef=useRef(null);
  const [sectionPhotoTarget,setSectionPhotoTarget]=useState(null); // section key
  const [sectionPhotoMode,setSectionPhotoMode]=useState(null); // "camera" or "library"
  // Trigger file input after state updates (replaces fragile setTimeout)
  useEffect(()=>{if(photoTarget&&photoMode==="camera")cameraRef.current?.click();if(photoTarget&&photoMode==="library")libraryRef.current?.click();},[photoTarget,photoMode]);
  useEffect(()=>{if(sectionPhotoTarget&&sectionPhotoMode==="camera")sectionPhotoRef.current?.click();if(sectionPhotoTarget&&sectionPhotoMode==="library")sectionLibraryRef.current?.click();},[sectionPhotoTarget,sectionPhotoMode]);
  const handleSectionPhoto=(e)=>{
    const files=Array.from(e.target.files||[]);
    if(!files.length||!sectionPhotoTarget)return;
    files.forEach(file=>{
      const reader=new FileReader();
      reader.onload=async(ev)=>{
        const compressed=await compressPhoto(ev.target.result);
        setSectionPhotos(p=>({...p,[sectionPhotoTarget]:[...(p[sectionPhotoTarget]||[]),{data:compressed,name:file.name,ts:Date.now()}]}));
      };
      reader.readAsDataURL(file);
    });
    e.target.value="";
    setSectionPhotoTarget(null);
    setSectionPhotoMode(null);
  };
  const removeSectionPhoto=(secKey,idx)=>{
    setSectionPhotos(p=>{const arr=[...(p[secKey]||[])];arr.splice(idx,1);return{...p,[secKey]:arr};});
  };
  const [weatherLoading,setWeatherLoading]=useState(false);

  const fs={width:"100%",padding:"12px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15};

  // WMO weather code → human-readable description
  const wmoDesc=(code)=>{
    const m={0:"Clear",1:"Mostly Clear",2:"Partly Cloudy",3:"Overcast",45:"Foggy",48:"Fog (Rime)",51:"Light Drizzle",53:"Drizzle",55:"Heavy Drizzle",56:"Light Freezing Drizzle",57:"Freezing Drizzle",61:"Light Rain",63:"Rain",65:"Heavy Rain",66:"Light Freezing Rain",67:"Freezing Rain",71:"Light Snow",73:"Snow",75:"Heavy Snow",77:"Snow Grains",80:"Light Showers",81:"Showers",82:"Heavy Showers",85:"Light Snow Showers",86:"Snow Showers",95:"Thunderstorm",96:"Thunderstorm + Hail",99:"Thunderstorm + Heavy Hail"};
    return m[code]||"Unknown";
  };

  // Toggle weather on — requires site address
  const toggleWeather=(on)=>{
    if(on&&!job.site_address){
      showToast("Add a site address in Job Settings to enable weather");
      return;
    }
    setWeatherEnabled(on);
    if(on&&!weatherAM)fetchWeather();
  };

  // Fetch weather from Open-Meteo (free, no API key)
  const fetchWeather=async()=>{
    if(!job.site_address){showToast("Add a site address in Job Settings to fetch weather");return;}
    setWeatherLoading(true);
    try{
      let lat,lng;
      // Geocode the job's site address using OpenStreetMap Nominatim (handles full addresses)
      try{
        const geoR=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(job.site_address)}&format=json&limit=1`,{headers:{"User-Agent":"MyDailyReports/1.0"}});
        const geoD=await geoR.json();
        if(geoD&&geoD.length>0){lat=parseFloat(geoD[0].lat);lng=parseFloat(geoD[0].lon);}
      }catch(e){console.log("Geocode failed:",e);}
      // Fallback: try Open-Meteo geocoding with just city name
      if(!lat||!lng){
        try{
          const cityMatch=job.site_address.match(/,\s*([^,]+),?\s*[A-Z]{2}/);
          const searchName=cityMatch?cityMatch[1].trim():job.site_address;
          const geoR2=await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchName)}&count=1&language=en&format=json`);
          const geoD2=await geoR2.json();
          if(geoD2.results&&geoD2.results.length>0){lat=geoD2.results[0].latitude;lng=geoD2.results[0].longitude;}
        }catch(e){console.log("Fallback geocode failed:",e);}
      }
      if(!lat||!lng){
        showToast("Could not find location — check the site address in Job Settings");
        setWeatherLoading(false);return;
      }
      // Fetch hourly weather for today
      const wxR=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m,precipitation&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=1`);
      const wxD=await wxR.json();
      if(!wxD.hourly||!wxD.hourly.time)throw new Error("No weather data");
      const h=wxD.hourly;
      // Pick representative hours: 7am (morning), 12pm (midday), 4pm (afternoon)
      const fmt=(idx)=>{
        if(idx<0||idx>=h.time.length)return"";
        const temp=Math.round(h.temperature_2m[idx]);
        const desc=wmoDesc(h.weather_code[idx]);
        const wind=Math.round(h.wind_speed_10m[idx]);
        const hum=Math.round(h.relative_humidity_2m[idx]);
        const precip=h.precipitation[idx];
        let s=`${temp}°F ${desc}, Wind ${wind} mph, ${hum}% humidity`;
        if(precip>0)s+=`, ${precip}" precip`;
        return s;
      };
      setWeatherAM(fmt(7));   // 7:00 AM
      setWeatherMid(fmt(12)); // 12:00 PM
      setWeatherPM(fmt(16));  // 4:00 PM
    }catch(e){console.error("Weather fetch:",e);showToast("Weather fetch failed — try again later");}
    finally{setWeatherLoading(false);}
  };

  // Load existing report on mount — or carry over contractors from most recent report
  useEffect(()=>{
    (async()=>{
      try{
        const rpt=await db.getReport(job.id,todayISO);
        let needsCarryOver=false;
        if(rpt){
          setDraftId(rpt.id);
          setWlReportStatus(rpt.status);
          if(rpt.content){
            let c;try{c=typeof rpt.content==="string"?JSON.parse(rpt.content):rpt.content;}catch(pe){console.error("Corrupt report content:",pe);c={};}
            if(c.contractors&&c.contractors.length>0)setContractors(c.contractors);
            else needsCarryOver=true; // today's report exists but has no contractors — try carry-over
            if(c.generalNotes)setGeneralNotes(c.generalNotes);
            if(c.safetyNotes)setSafetyNotes(c.safetyNotes);
            if(c.materials)setMaterials(c.materials);
            if(c.equipment)setEquipment(c.equipment);
            if(c.qualityControl)setQualityControl(c.qualityControl);
            if(c.customCategories)setCustomCategories(c.customCategories);
            if(c.survey)setSurvey(c.survey);
            if(c.weatherEnabled)setWeatherEnabled(true);
            if(c.weatherAM)setWeatherAM(c.weatherAM);
            if(c.weatherMid)setWeatherMid(c.weatherMid);
            if(c.weatherPM)setWeatherPM(c.weatherPM);
            if(c.sectionPhotos)setSectionPhotos(c.sectionPhotos);
            if(c.sectionCarry)setSectionCarry(c.sectionCarry);
          }else{needsCarryOver=true;} // today's report has no content yet
        } else {
          needsCarryOver=true;
        }
        // Carry over from most recent previous report (when today has no contractors)
        if(needsCarryOver){
          try{
            const prev=await db.getLatestReport(job.id,todayISO);
            console.log("[carry-over] prev report:",prev?.report_date,prev?.status,"has content:",!!prev?.content);
            if(prev&&prev.content){
              const pc=typeof prev.content==="string"?JSON.parse(prev.content):prev.content;
              console.log("[carry-over] prev contractors:",pc.contractors?.length,"locked:",pc.contractors?.filter(ct=>ct.locked)?.length);
              // Carry over locked contractors — clear daily data (photos, hours)
              if(pc.contractors&&pc.contractors.length>0){
                const locked=pc.contractors.filter(ct=>ct.locked);
                if(locked.length>0){
                  const carried=locked.map(ct=>({
                    id:Date.now().toString()+Math.random().toString(36).slice(2,6),
                    name:ct.name||"",
                    description:ct.carryDesc===false?"":ct.description||"",
                    hours:"",
                    quantity:ct.quantity||"1",
                    photos:[],
                    locked:true,
                    carryDesc:ct.carryDesc!==undefined?ct.carryDesc:true
                  }));
                  setContractors(carried);
                  console.log("[carry-over] carried",carried.length,"contractors");
                }
              }
              // Carry over section values only if carry-over toggled on (clear photos, keep text)
              const sc=pc.sectionCarry||{};
              if(pc.materials&&sc.materials)setMaterials(pc.materials);
              if(pc.equipment&&sc.equipment)setEquipment(pc.equipment);
              if(pc.qualityControl&&sc.qualityControl)setQualityControl(pc.qualityControl);
              if(pc.customCategories)setCustomCategories(pc.customCategories);
              if(sc)setSectionCarry(sc);
            }
          }catch(pe){console.error("Carry-over:",pe);}
        }
      }catch(e){console.error(e);}
    })();
  },[]);

  const addContractor=()=>{
    if(!newName.trim())return;
    const c={id:Date.now().toString(),name:newName.trim(),description:"",hours:"",quantity:"1",photos:[],locked:false,active:true};
    setContractors(p=>[...p,c]);
    setActiveId(c.id);
    setNewName("");
    setShowAdd(false);
  };

  const updateContractor=(id,field,val)=>{
    setContractors(p=>p.map(c=>c.id===id?{...c,[field]:val}:c));
  };

  const removeContractor=async(id)=>{
    if(!await askConfirm("Remove this contractor?"))return;
    setContractors(p=>p.filter(c=>c.id!==id));
    if(activeId===id)setActiveId(null);
  };

  // Compress photo to max 1600px, JPEG quality 0.7 (~150KB vs 4MB raw)
  const compressPhoto=(dataUrl)=>new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      const MAX=1600;
      let w=img.width,h=img.height;
      if(w>MAX||h>MAX){const r=Math.min(MAX/w,MAX/h);w=Math.round(w*r);h=Math.round(h*r);}
      const cvs=document.createElement("canvas");cvs.width=w;cvs.height=h;
      cvs.getContext("2d").drawImage(img,0,0,w,h);
      resolve(cvs.toDataURL("image/jpeg",0.7));
    };
    img.onerror=()=>resolve(dataUrl); // fallback to original
    img.src=dataUrl;
  });

  // Downscale image for AI vision — 800px max, lower quality (description doesn't need full-res)
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

  // AI photo description — calls describe-photo edge function
  const [aiDescribing,setAiDescribing]=useState({}); // keyed by uniqueId e.g. "contractor-{cid}-{photoIdx}"
  const [aiUsageCount,setAiUsageCount]=useState(getAiUsageCount(job?.id));
  const aiLimitReached=aiUsageCount>=AI_DESCRIBE_DAILY_LIMIT;
  const describePhoto=async(imageDataUrl,context,uniqueId)=>{
    if(!checkAiLimit(job?.id)){showToast(`AI limit reached (${AI_DESCRIBE_DAILY_LIMIT}/day). Resets tomorrow.`);return null;}
    setAiDescribing(p=>({...p,[uniqueId]:true}));
    try{
      // Downscale for AI vision (800px vs 1600px stored), then strip prefix
      const aiImg=await downscaleForAI(imageDataUrl);
      const b64=aiImg.includes(",")?aiImg.split(",")[1]:aiImg;
      const formData=new FormData();
      formData.append("image_base64",b64);
      formData.append("context",context);
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

  const handlePhotoUpload=(e)=>{
    const files=Array.from(e.target.files||[]);
    if(!files.length||!photoTarget)return;
    files.forEach(file=>{
      const reader=new FileReader();
      reader.onload=async(ev)=>{
        const compressed=await compressPhoto(ev.target.result);
        setContractors(p=>p.map(c=>{
          if(c.id!==photoTarget)return c;
          return{...c,photos:[...(c.photos||[]),{data:compressed,name:file.name,ts:Date.now()}]};
        }));
      };
      reader.readAsDataURL(file);
    });
    e.target.value="";
    setPhotoTarget(null);setPhotoMode(null);
  };
  const cameraRef=useRef(null);
  const libraryRef=useRef(null);

  const removePhoto=(contractorId,photoIdx)=>{
    setContractors(p=>p.map(c=>{
      if(c.id!==contractorId)return c;
      const ph=[...(c.photos||[])];
      ph.splice(photoIdx,1);
      return{...c,photos:ph};
    }));
  };

  const [submitSuccess,setSubmitSuccess]=useState(null); // {pdfBlob,pdfFilename,pdfBase64,emailHtml,...}
  const [emailing,setEmailing]=useState(false);
  const [toast,setToast]=useState("");
  const showToast=(m)=>{setToast(m);setTimeout(()=>setToast(""),3000);};

  const buildContent=()=>({
    contractors,generalNotes,safetyNotes,materials,equipment,qualityControl,customCategories,survey,
    weatherEnabled,weatherAM,weatherMid,weatherPM,sectionPhotos,sectionCarry,
    reportType:"worklog"
  });

  // ── Generate Work Log PDF with pdf-lib ──
  const generateWorkLogPdf=async()=>{
    const PDFLib=await ensurePdfLib();
    const {PDFDocument,rgb,StandardFonts}=PDFLib;
    const doc=await PDFDocument.create();
    const font=await doc.embedFont(StandardFonts.TimesRoman);
    const fontB=await doc.embedFont(StandardFonts.TimesRomanBold);
    const W=612,H=792; // letter size
    const M=40; // margin
    const CW=W-2*M; // content width

    const todayDisplay2=new Date(todayISO+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric",timeZone:tz});
    const userName=window._mdrUserName||user?.user_metadata?.full_name||"";

    let page;
    let y=H-M;
    let pageNum=1;
    const totalPagesRef={val:1}; // will update after building
    // ── Page 1 Header — light grey bar, title LEFT, logo RIGHT ──
    page=doc.addPage([W,H]);
    const headerH=90;
    const hdrPad=10; // inner padding

    // Light grey header bar with margins
    page.drawRectangle({x:M,y:H-headerH,width:CW,height:headerH,color:rgb(.85,.85,.85)});

    // Embed logo — job logo → company logo → profile company logo
    let logoImg=null;
    let logoDrawW=0,logoDrawH=0;
    try{
      let logoBytes=null;let isJpg=true;
      // Logo fallback chain: 1) Job logo → 2) Company logo → 3) Profile company logo
      const fetchLogoBytes=async(url)=>{
        if(!url)return null;
        try{
          if(url.startsWith("data:image")){
            const b64=url.split(",")[1];const bin=atob(b64);
            const arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
            isJpg=!url.includes("image/png");return arr;
          }else{
            const resp=await fetch(url);
            if(resp.ok){isJpg=url.toLowerCase().endsWith(".jpg")||url.toLowerCase().endsWith(".jpeg")||resp.headers.get("content-type")?.includes("jpeg");return new Uint8Array(await resp.arrayBuffer());}
          }
        }catch(e){console.error("Logo decode:",e);}
        return null;
      };
      // 1. Try job-level logo
      const jobLogoUrl=await db.getJobLogoUrl(job.id);
      if(jobLogoUrl)logoBytes=await fetchLogoBytes(jobLogoUrl);
      // 2. Try company logos (job's company, then profile's company)
      if(!logoBytes){
        const companyIds=[job.company_id];
        try{const prof=await db.getProfile(user.id);if(prof?.company_id&&prof.company_id!==job.company_id)companyIds.push(prof.company_id);}catch(e){}
        for(const cid of companyIds){
          if(!cid||logoBytes)continue;
          const cLogoUrl=await db.getCompanyLogoUrl(cid);
          if(cLogoUrl)logoBytes=await fetchLogoBytes(cLogoUrl);
        }
      }
      if(logoBytes){
        logoImg=isJpg?await doc.embedJpg(logoBytes):await doc.embedPng(logoBytes);
        const logoMaxH=headerH-2*hdrPad;
        const logoMaxW=140;
        const scl=Math.min(logoMaxW/logoImg.width,logoMaxH/logoImg.height);
        logoDrawW=logoImg.width*scl;
        logoDrawH=logoImg.height*scl;
        // Logo on RIGHT side, vertically centered
        const logoX=W-M-hdrPad-logoDrawW;
        const logoY2=H-headerH+(headerH-logoDrawH)/2;
        page.drawImage(logoImg,{x:logoX,y:logoY2,width:logoDrawW,height:logoDrawH});
      }
    }catch(e){console.error("Logo embed:",e);}

    // Job title — large, dark text, LEFT side
    const jobTitle=job.name||"Daily Work Log";
    const titleStartX=M+hdrPad;
    const maxTitleW=CW-logoDrawW-3*hdrPad; // leave room for logo
    let titleSize=jobTitle.length>30?16:jobTitle.length>20?18:22;
    while(titleSize>10&&fontB.widthOfTextAtSize(jobTitle,titleSize)>maxTitleW)titleSize-=1;
    if(fontB.widthOfTextAtSize(jobTitle,titleSize)>maxTitleW){
      const words=jobTitle.split(" ");let l1="",l2="";
      for(const w of words){const t=l1?l1+" "+w:w;if(fontB.widthOfTextAtSize(t,titleSize)>maxTitleW&&l1){l2=words.slice(words.indexOf(w)).join(" ");break;}else l1=t;}
      page.drawText(l1,{x:titleStartX,y:H-36,size:titleSize,font:fontB,color:rgb(.15,.15,.15)});
      if(l2)page.drawText(l2,{x:titleStartX,y:H-50,size:titleSize,font:fontB,color:rgb(.15,.15,.15)});
    }else{
      page.drawText(jobTitle,{x:titleStartX,y:H-40,size:titleSize,font:fontB,color:rgb(.15,.15,.15)});
    }
    // Site address below title
    if(job.site_address)page.drawText(job.site_address,{x:titleStartX,y:H-58,size:10,font,color:rgb(.35,.35,.35)});

    // Info bar below header (dark, with Date / Job # / Prepared By)
    const infoBarH=26;
    const infoBarY=H-headerH-infoBarH;
    page.drawRectangle({x:M,y:infoBarY,width:CW,height:infoBarH,color:rgb(.22,.22,.22)});
    const dateStr=new Date(todayISO+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"2-digit",day:"2-digit",year:"numeric",timeZone:tz});
    const infoTextY=infoBarY+8;
    // Date
    page.drawText("Date",{x:M+8,y:infoTextY,size:8,font:fontB,color:rgb(.55,.55,.55)});
    page.drawText(dateStr,{x:M+36,y:infoTextY,size:9,font:fontB,color:rgb(1,1,1)});
    // Job #
    const jobNum=job.job_number||job.name||"";
    const jx=W*0.38;
    page.drawText("Job #",{x:jx,y:infoTextY,size:8,font:fontB,color:rgb(.55,.55,.55)});
    page.drawText(jobNum,{x:jx+34,y:infoTextY,size:9,font:fontB,color:rgb(1,1,1)});
    // Prepared By
    const px=W*0.62;
    page.drawText("Prepared By",{x:px,y:infoTextY,size:8,font:fontB,color:rgb(.55,.55,.55)});
    page.drawText(userName||"—",{x:px+66,y:infoTextY,size:9,font:fontB,color:rgb(1,1,1)});

    y=infoBarY-10; // start dynamic content below info bar

    const ensureSpace=(needed)=>{
      if(y-needed<M+30){
        page=doc.addPage([W,H]);y=H-M;pageNum++;totalPagesRef.val=pageNum;
        drawFooter(page);
      }
    };

    const drawFooter=(pg)=>{}; // footers added in bulk at end

    // ── Weather section — MDR-style: 3 time slots with big temp, condition, details ──
    if(weatherEnabled&&(weatherAM||weatherMid||weatherPM)){
      // Parse weather string like "78°F Clear, Wind 19 mph, 14% humidity, 0.1" precip"
      const parseWx=(str)=>{
        if(!str)return{temp:"—",cond:"",wind:"",precip:"0\"",humidity:""};
        const m=str.match(/^(\d+)°F\s+([^,]+)/);
        const temp=m?m[1]+"°":"—";
        const cond=m?m[2].trim():"";
        const windM=str.match(/Wind\s+(\d+)\s*mph/i);
        const wind=windM?windM[1]+" MPH":"0 MPH";
        const humM=str.match(/(\d+)%\s*humidity/i);
        const humidity=humM?humM[1]+"%":"";
        const precM=str.match(/([\d.]+)"\s*precip/i);
        const precip=precM?precM[1]+"\"":"0\"";
        return{temp,cond,wind,precip,humidity};
      };

      // Section header bar
      ensureSpace(140);
      page.drawRectangle({x:M,y:y-30,width:CW,height:30,color:rgb(.45,.45,.45)});
      page.drawText("Weather",{x:M+(CW-fontB.widthOfTextAtSize("Weather",16))/2,y:y-22,size:16,font:fontB,color:rgb(.92,.57,.17)});
      y-=36;

      const wxSlots=[
        {label:"6:00 AM",val:weatherAM},
        {label:"12:00 PM",val:weatherMid},
        {label:"4:00 PM",val:weatherPM}
      ];
      const slotW=CW/3;
      const slotH=100; // height of each weather box
      ensureSpace(slotH+20);

      wxSlots.forEach((wx,i)=>{
        const sx=M+i*slotW;
        const px=parseWx(wx.val);
        // Box with light border
        page.drawRectangle({x:sx,y:y-slotH,width:slotW,height:slotH,color:rgb(1,1,1),borderColor:rgb(.88,.88,.88),borderWidth:.5});
        // Time label centered at top
        const labelW=fontB.widthOfTextAtSize(wx.label,9);
        page.drawText(wx.label,{x:sx+(slotW-labelW)/2,y:y-14,size:9,font:fontB,color:rgb(.35,.35,.35)});
        // Big temperature number centered
        const tempStr=px.temp;
        const tempW=fontB.widthOfTextAtSize(tempStr,28);
        page.drawText(tempStr,{x:sx+(slotW-tempW)/2,y:y-46,size:28,font:fontB,color:rgb(.15,.15,.15)});
        // Condition name centered below temp
        if(px.cond){
          const condW=font.widthOfTextAtSize(px.cond,10);
          page.drawText(px.cond,{x:sx+(slotW-condW)/2,y:y-60,size:10,font,color:rgb(.3,.3,.3)});
        }
        // Details row: Wind | Precipitation | Humidity
        const detY=y-slotH+12;
        const detFontSz=7;
        const sep=" | ";
        const detParts=[];
        if(px.wind)detParts.push("Wind: "+px.wind);
        detParts.push("Precipitation: "+px.precip);
        if(px.humidity)detParts.push("Humidity: "+px.humidity);
        const detStr=detParts.join("  "+sep+"  ");
        const detW=font.widthOfTextAtSize(detStr,detFontSz);
        page.drawText(detStr,{x:sx+(slotW-detW)/2,y:detY,size:detFontSz,font,color:rgb(.45,.45,.45)});
      });
      y-=(slotH+8);
    }

    // ── Work Logs — MDR-style table ──
    // Section header bar
    ensureSpace(40);
    page.drawRectangle({x:M,y:y-30,width:CW,height:30,color:rgb(.45,.45,.45)});
    page.drawText("Work Logs",{x:M+(CW-fontB.widthOfTextAtSize("Work Logs",16))/2,y:y-22,size:16,font:fontB,color:rgb(.92,.57,.17)});
    y-=36;

    // Column header row
    const nameW=130,qtyW=65,hrsW=80;
    const descW=CW-nameW-qtyW-hrsW;
    page.drawRectangle({x:M,y:y-22,width:CW,height:22,color:rgb(.97,.97,.97)});
    page.drawLine({start:{x:M,y:y-22},end:{x:M+CW,y:y-22},thickness:.5,color:rgb(.85,.85,.85)});
    page.drawText("Name",{x:M+10,y:y-15,size:10,font:fontB,color:rgb(.3,.3,.3)});
    page.drawText("Description",{x:M+nameW+10,y:y-15,size:10,font:fontB,color:rgb(.3,.3,.3)});
    page.drawText("Quantity",{x:M+nameW+descW+8,y:y-15,size:10,font:fontB,color:rgb(.3,.3,.3)});
    page.drawText("Total Hours",{x:M+nameW+descW+qtyW+6,y:y-15,size:10,font:fontB,color:rgb(.3,.3,.3)});
    y-=24;

    let totalHrs=0;
    const lineH=17; // line height for description text — generous like MDR
    const descFontSz=11;
    const nameFontSz=11;
    const attrSz=8; // attribution line size
    const rowPadTop=16; // top padding inside row
    const rowPadBot=16; // bottom padding inside row
    const attrGap=10; // gap between last desc line and attribution

    contractors.filter(c=>c.active!==false).forEach((c,ri)=>{
      const hrs=parseFloat(c.hours)||0;
      const qty=parseInt(c.quantity)||1;
      totalHrs+=hrs*qty;

      // Wrap description text — split on newlines first, then wrap each paragraph
      const descLines=[];
      if(c.description){
        c.description.split("\n").forEach(paragraph=>{
          if(!paragraph.trim()){descLines.push("");return;}
          const words=paragraph.split(" ");
          let line="";
          const maxW=descW-20;
          words.forEach(w=>{
            const test=line?line+" "+w:w;
            if(font.widthOfTextAtSize(test,descFontSz)>maxW&&line){descLines.push(line);line=w;}
            else line=test;
          });
          if(line)descLines.push(line);
        });
      }
      if(descLines.length===0)descLines.push("—");

      // Wrap name if long
      const nameLines=[];
      const nameWords=(c.name||"—").split(" ");
      let nl2="";
      nameWords.forEach(w=>{const t=nl2?nl2+" "+w:w;if(fontB.widthOfTextAtSize(t,nameFontSz)>(nameW-20)&&nl2){nameLines.push(nl2);nl2=w;}else nl2=t;});
      if(nl2)nameLines.push(nl2);

      // Attribution line: "UserName | date, time"
      const now=new Date();
      const attrText=(userName||"Inspector")+" | "+new Date(todayISO+"T12:00:00").toLocaleDateString("en-US",{month:"numeric",day:"numeric",year:"2-digit",timeZone:tz})+", "+now.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true,timeZone:tz});

      // Calculate content height: desc lines + attribution
      const descH=descLines.reduce((h,ln)=>h+(ln===""?lineH*0.6:lineH),0);
      const nameH=nameLines.length*16;
      const contentH=Math.max(nameH, descH + attrGap + 12); // 12 for attribution line
      const rowH=Math.max(60, rowPadTop + contentH + rowPadBot);
      ensureSpace(rowH);

      // Row background + border
      page.drawRectangle({x:M,y:y-rowH,width:CW,height:rowH,borderColor:rgb(.85,.85,.85),borderWidth:.5,color:ri%2===0?rgb(.99,.99,.99):rgb(1,1,1)});
      // Bottom border line
      page.drawLine({start:{x:M,y:y-rowH},end:{x:M+CW,y:y-rowH},thickness:.5,color:rgb(.8,.8,.8)});

      // Name — top-aligned with padding
      nameLines.forEach((ln,li)=>{
        page.drawText(ln,{x:M+10,y:y-rowPadTop-12-li*16,size:nameFontSz,font:fontB,color:rgb(.15,.15,.15)});
      });

      // Description — top-aligned with padding
      let dy=y-rowPadTop-12;
      descLines.forEach(ln=>{
        if(ln===""){dy-=lineH*0.6;return;}
        page.drawText(ln,{x:M+nameW+10,y:dy,size:descFontSz,font,color:rgb(.25,.25,.25)});
        dy-=lineH;
      });

      // Attribution line below description
      dy-=attrGap;
      page.drawText(attrText,{x:M+nameW+10,y:dy,size:attrSz,font,color:rgb(.6,.6,.6)});

      // Quantity — top-aligned matching first desc line
      page.drawText(String(qty),{x:M+nameW+descW+(qtyW-font.widthOfTextAtSize(String(qty),descFontSz))/2,y:y-rowPadTop-12,size:descFontSz,font,color:rgb(.2,.2,.2)});

      // Total Hours — top-aligned
      const hrsStr=hrs?String(hrs):"0";
      page.drawText(hrsStr,{x:M+nameW+descW+qtyW+(hrsW-font.widthOfTextAtSize(hrsStr,descFontSz))/2,y:y-rowPadTop-12,size:descFontSz,font,color:rgb(.2,.2,.2)});

      y-=rowH;
    });

    // Totals row (dark background like MDR)
    ensureSpace(28);
    page.drawRectangle({x:M,y:y-28,width:CW,height:28,color:rgb(.35,.35,.35)});
    page.drawText("Total",{x:M+10,y:y-19,size:12,font:fontB,color:rgb(1,1,1)});
    const totalQty=contractors.reduce((s,c)=>s+(parseInt(c.quantity)||1),0);
    page.drawText(String(totalQty),{x:M+nameW+descW+(qtyW-fontB.widthOfTextAtSize(String(totalQty),12))/2,y:y-19,size:12,font:fontB,color:rgb(1,1,1)});
    page.drawText(String(totalHrs),{x:M+nameW+descW+qtyW+(hrsW-fontB.widthOfTextAtSize(String(totalHrs),12))/2,y:y-19,size:12,font:fontB,color:rgb(1,1,1)});
    y-=36;

    // ── Helper: draw a MDR-style text section ──
    const drawTextSection=(title,text)=>{
      if(!text||!text.trim()){return;}
      // Split into lines, each non-empty line becomes a bullet
      let rawLines=text.split("\n").filter(l=>l.trim());
      // If dictated as one block (no newlines), split by sentences so each gets its own bullet
      if(rawLines.length===1){const sentences=rawLines[0].split(/(?<=\.)\s+/).filter(s=>s.trim());if(sentences.length>1)rawLines=sentences;}
      const fontSize=11;
      const lineHeight=16; // spacing within a wrapped bullet
      const bulletGap=18; // double-space between separate bullets
      const bulletChar="•";
      const bulletIndent=24; // left indent for bullet character
      const textIndent=36; // left indent for text (after bullet)
      const bulletW=font.widthOfTextAtSize(bulletChar,fontSize);
      const contentW=CW-textIndent-12; // text indent + right pad
      // Build wrapped lines with bullet markers and gap markers
      const wrapLines=[]; // {text, bullet:bool, gapBefore:bool}
      rawLines.forEach((line,idx)=>{
        const clean=line.replace(/^[\-\•\*]\s*/,"").trim();
        if(!clean)return;
        const words=clean.split(" ");let wl="";let first=true;
        words.forEach(w=>{const t=wl?wl+" "+w:w;if(font.widthOfTextAtSize(t,fontSize)>contentW&&wl){wrapLines.push({text:wl,bullet:first,gapBefore:first&&wrapLines.length>0});first=false;wl=w;}else wl=t;});
        if(wl)wrapLines.push({text:wl,bullet:first,gapBefore:first&&wrapLines.length>0});
      });
      // Calculate box height: each line + bullet gaps
      let boxH=16; // top+bottom padding
      wrapLines.forEach(ln=>{boxH+=lineHeight;if(ln.gapBefore)boxH+=bulletGap;});
      const totalNeeded=36+boxH+6;
      ensureSpace(Math.min(totalNeeded,H-M-30));
      page.drawRectangle({x:M,y:y-30,width:CW,height:30,color:rgb(.45,.45,.45)});
      page.drawText(title,{x:M+(CW-fontB.widthOfTextAtSize(title,14))/2,y:y-22,size:14,font:fontB,color:rgb(.92,.57,.17)});
      y-=36;
      ensureSpace(boxH);
      page.drawRectangle({x:M,y:y-boxH,width:CW,height:boxH,borderColor:rgb(.85,.85,.85),borderWidth:.5,color:rgb(1,1,1)});
      let ty=y-14;
      wrapLines.forEach(ln=>{
        if(ln.gapBefore)ty-=bulletGap;
        if(ln.bullet)page.drawText(bulletChar,{x:M+bulletIndent,y:ty,size:fontSize,font,color:rgb(.2,.2,.2)});
        page.drawText(ln.text,{x:M+textIndent,y:ty,size:fontSize,font,color:rgb(.2,.2,.2)});
        ty-=lineHeight;
      });
      y-=boxH+6;
    };

    // ── Work Log Photos — right after work logs, before text sections ──
    const contractorsWithPhotos=contractors.filter(c=>c.active!==false&&(c.photos||[]).length>0);
    if(contractorsWithPhotos.length>0){
      ensureSpace(50);
      page.drawRectangle({x:M,y:y-30,width:CW,height:30,color:rgb(.45,.45,.45)});
      page.drawText("Work Log Photos",{x:M+(CW-fontB.widthOfTextAtSize("Work Log Photos",14))/2,y:y-22,size:14,font:fontB,color:rgb(.92,.57,.17)});
      y-=40;

      const cols=4;
      const photoGap=6;
      const imgW=Math.floor((CW-(cols-1)*photoGap)/cols);
      const imgH=Math.floor(imgW*0.75); // 4:3 aspect

      for(const c of contractorsWithPhotos){
        const hrs=parseFloat(c.hours)||0;
        const qty=parseInt(c.quantity)||1;
        ensureSpace(imgH+30);
        page.drawText(c.name+":",{x:M+4,y:y-14,size:12,font:fontB,color:rgb(.15,.15,.15)});
        const labelW=fontB.widthOfTextAtSize(c.name+":",12);
        page.drawText(`  | QTY: `,{x:M+4+labelW,y:y-14,size:10,font,color:rgb(.5,.5,.5)});
        const q1W=font.widthOfTextAtSize(`  | QTY: `,10);
        page.drawText(String(qty),{x:M+4+labelW+q1W,y:y-14,size:10,font:fontB,color:rgb(.92,.57,.17)});
        const q2W=fontB.widthOfTextAtSize(String(qty),10);
        page.drawText(` | HRS: `,{x:M+4+labelW+q1W+q2W,y:y-14,size:10,font,color:rgb(.5,.5,.5)});
        const h1W=font.widthOfTextAtSize(` | HRS: `,10);
        page.drawText(hrs.toFixed(1),{x:M+4+labelW+q1W+q2W+h1W,y:y-14,size:10,font:fontB,color:rgb(.92,.57,.17)});
        y-=22;

        const photos=c.photos||[];
        let pi=0;
        while(pi<photos.length){
          const rowPhotos=photos.slice(pi,pi+cols);
          ensureSpace(imgH+10);
          for(let ri=0;ri<rowPhotos.length;ri++){
            const ph=rowPhotos[ri];
            try{
              const imgBytes=Uint8Array.from(atob(ph.data.split(",")[1]||""),ch=>ch.charCodeAt(0));
              let img;
              if(ph.data.includes("image/png"))img=await doc.embedPng(imgBytes);
              else img=await doc.embedJpg(imgBytes);
              const xPos=M+ri*(imgW+photoGap);
              const scl=Math.min(imgW/img.width,imgH/img.height,1);
              const pw=img.width*scl,ph2=img.height*scl;
              page.drawImage(img,{x:xPos,y:y-ph2,width:pw,height:ph2});
              const stampH=12;
              page.drawRectangle({x:xPos,y:y-ph2,width:pw,height:stampH,color:rgb(.2,.2,.2),opacity:0.7});
              const stamp=ph.ts?new Date(ph.ts).toLocaleString("en-US",{month:"2-digit",day:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit",hour12:true,timeZone:tz}):"";
              if(stamp)page.drawText(stamp,{x:xPos+3,y:y-ph2+2,size:6,font,color:rgb(1,1,1)});
            }catch(e){console.error("Photo embed error:",e);}
          }
          pi+=rowPhotos.length;
          y-=(imgH+photoGap);
        }
        y-=6;
      }
    }

    // Helper: draw section photos inline
    const drawSectionPhotos=async(secKey)=>{
      const photos=sectionPhotos[secKey]||[];
      if(!photos.length)return;
      const cols=4,photoGap=6;
      const imgW=Math.floor((CW-(cols-1)*photoGap)/cols);
      const imgH=Math.floor(imgW*0.75);
      let pi=0;
      while(pi<photos.length){
        const row=photos.slice(pi,pi+cols);
        ensureSpace(imgH+10);
        for(let ri=0;ri<row.length;ri++){
          try{
            const ph=row[ri];
            const imgBytes=Uint8Array.from(atob(ph.data.split(",")[1]||""),ch=>ch.charCodeAt(0));
            let img;
            if(ph.data.includes("image/png"))img=await doc.embedPng(imgBytes);
            else img=await doc.embedJpg(imgBytes);
            const xPos=M+ri*(imgW+photoGap);
            const scl=Math.min(imgW/img.width,imgH/img.height,1);
            const pw=img.width*scl,ph2=img.height*scl;
            page.drawImage(img,{x:xPos,y:y-ph2,width:pw,height:ph2});
          }catch(e){console.error("Section photo embed:",e);}
        }
        pi+=row.length;
        y-=(imgH+photoGap);
      }
      y-=4;
    };

    // ── Materials ──
    drawTextSection("Materials",materials);
    await drawSectionPhotos("materials");

    // ── Equipment ──
    drawTextSection("Equipment",equipment);
    await drawSectionPhotos("equipment");

    // ── General Notes ──
    drawTextSection("General Notes",generalNotes);
    await drawSectionPhotos("generalNotes");

    // ── Site Safety Observations ──
    drawTextSection("Site Safety Observations",safetyNotes);
    await drawSectionPhotos("safetyNotes");

    // ── Quality Control Observations ──
    drawTextSection("Quality Control Observations",qualityControl);
    await drawSectionPhotos("qualityControl");

    // ── Custom Categories ──
    if(customCategories&&customCategories.length>0){
      customCategories.forEach(cat=>{
        if(cat.title||cat.value)drawTextSection(cat.title||"Untitled Category",cat.value);
      });
    }

    // ── Survey ──
    ensureSpace(40);
    page.drawRectangle({x:M,y:y-30,width:CW,height:30,color:rgb(.45,.45,.45)});
    page.drawText("Survey",{x:M+(CW-fontB.widthOfTextAtSize("Survey",14))/2,y:y-22,size:14,font:fontB,color:rgb(.92,.57,.17)});
    y-=36;
    // Survey column headers
    const sqW=CW-200; // question column
    const scW=50; // each checkbox column (N/A, No, Yes)
    const sdW=CW-sqW-scW*3; // description column
    ensureSpace(22);
    page.drawRectangle({x:M,y:y-22,width:CW,height:22,color:rgb(.97,.97,.97)});
    page.drawLine({start:{x:M,y:y-22},end:{x:M+CW,y:y-22},thickness:.5,color:rgb(.85,.85,.85)});
    page.drawText("Questions",{x:M+10,y:y-15,size:10,font:fontB,color:rgb(.3,.3,.3)});
    page.drawText("N/A",{x:M+sqW+(scW-fontB.widthOfTextAtSize("N/A",9))/2,y:y-15,size:9,font:fontB,color:rgb(.3,.3,.3)});
    page.drawText("No",{x:M+sqW+scW+(scW-fontB.widthOfTextAtSize("No",9))/2,y:y-15,size:9,font:fontB,color:rgb(.3,.3,.3)});
    page.drawText("Yes",{x:M+sqW+scW*2+(scW-fontB.widthOfTextAtSize("Yes",9))/2,y:y-15,size:9,font:fontB,color:rgb(.3,.3,.3)});
    page.drawText("Description",{x:M+sqW+scW*3+8,y:y-15,size:9,font:fontB,color:rgb(.3,.3,.3)});
    y-=24;

    // Filter out custom questions (index >= 6) with no question text
    const surveyFiltered=survey.filter((s,si)=>si<6||s.q?.trim());
    surveyFiltered.forEach((s,si)=>{
      // Wrap question text if it exceeds question column width
      const qFullText=`${si+1}. ${s.q||""}`;
      const qMaxW=sqW-20;
      const qLines=[];
      const qWords=qFullText.split(" ");let ql="";
      qWords.forEach(w=>{const t=ql?ql+" "+w:w;if(fontB.widthOfTextAtSize(t,10)>qMaxW&&ql){qLines.push(ql);ql=w;}else ql=t;});
      if(ql)qLines.push(ql);
      const qLinesH=qLines.length*14;
      const rowH=Math.max(40,qLinesH+24+(s.desc?14:0));
      ensureSpace(rowH);
      page.drawRectangle({x:M,y:y-rowH,width:CW,height:rowH,borderColor:rgb(.85,.85,.85),borderWidth:.5,color:si%2===0?rgb(.99,.99,.99):rgb(1,1,1)});
      // Question text (wrapped)
      let qy=y-18;
      qLines.forEach(ln=>{page.drawText(ln,{x:M+10,y:qy,size:10,font:fontB,color:rgb(.2,.2,.2)});qy-=14;});
      // Checkboxes
      const boxSz=12,boxY=y-20;
      ["N/A","No","Yes"].forEach((opt,oi)=>{
        const bx=M+sqW+scW*oi+(scW-boxSz)/2;
        page.drawRectangle({x:bx,y:boxY,width:boxSz,height:boxSz,borderColor:rgb(.5,.5,.5),borderWidth:1,color:rgb(1,1,1)});
        if(s.answer===opt){
          // Draw an X checkmark (standard fonts don't support Unicode ✓)
          page.drawLine({start:{x:bx+2,y:boxY+2},end:{x:bx+boxSz-2,y:boxY+boxSz-2},thickness:1.5,color:rgb(.15,.15,.15)});
          page.drawLine({start:{x:bx+2,y:boxY+boxSz-2},end:{x:bx+boxSz-2,y:boxY+2},thickness:1.5,color:rgb(.15,.15,.15)});
        }
      });
      // Description
      if(s.desc){
        page.drawText(s.desc,{x:M+sqW+scW*3+8,y:y-18,size:9,font,color:rgb(.3,.3,.3)});
      }
      y-=rowH;
    });
    y-=10;

    // Add footers to all pages — job name left, page num center-right, "Powered by" right
    const pages=doc.getPages();
    pages.forEach((pg,i)=>{
      pg.drawText(job.name||"Work Log",{x:M,y:20,size:8,font,color:rgb(.5,.5,.5)});
      const pgTxt=`${i+1} of ${pages.length}`;
      const pgW=font.widthOfTextAtSize(pgTxt,8);
      pg.drawText(pgTxt,{x:W-M-pgW,y:20,size:8,font,color:rgb(.5,.5,.5)});
      const pwrTxt="Powered by My Daily Reports";
      const pwrW=font.widthOfTextAtSize(pwrTxt,7);
      pg.drawText(pwrTxt,{x:(W-pwrW)/2,y:10,size:7,font,color:rgb(.6,.6,.6)});
    });

    return await doc.save();
  };

  // ── View/Preview: generate PDF and render pages as images ──
  const viewWorkLog=async()=>{
    const activeContractors=contractors.filter(c=>c.active!==false);
    if(activeContractors.length===0){showToast("No active contractors. Toggle at least one on.");return;}
    setViewLoading(true);
    try{
      const pdfBytes=await generateWorkLogPdf();
      await ensurePdfJs();
      if(!window.pdfjsLib)throw new Error("PDF viewer not loaded.");
      const pjDoc=await window.pdfjsLib.getDocument({data:pdfBytes}).promise;
      const pages=[];
      const scale=2;
      for(let pi=1;pi<=pjDoc.numPages;pi++){
        const pg=await pjDoc.getPage(pi);
        const vp=pg.getViewport({scale});
        const cvs=document.createElement("canvas");cvs.width=vp.width;cvs.height=vp.height;
        const ctx=cvs.getContext("2d");
        await pg.render({canvasContext:ctx,viewport:vp}).promise;
        pages.push(cvs.toDataURL("image/jpeg",0.92));
        cvs.width=0;cvs.height=0;
      }
      setViewingPreview(pages);
    }catch(e){
      console.error("Preview error:",e);
      showToast("Preview failed: "+e.message);
    }finally{setViewLoading(false);}
  };

  // ── Submit: generate PDF, upload, save ──
  const submitWorkLog=async()=>{
    setSubmitting(true);setWlSubmitStep("Generating PDF...");
    try{
      const submitDate=reportDate||new Date().toLocaleDateString("en-CA",{timeZone:tz});
      const pdfBytes=await generateWorkLogPdf();
      const pdfBlob=new Blob([pdfBytes],{type:"application/pdf"});
      const pdfFilename=`${(job.name||"WorkLog").replace(/[^a-zA-Z0-9_ -]/g,"")}_${submitDate}.pdf`;

      // Upload PDF to storage (with timeout for flaky connections)
      setWlSubmitStep("Uploading report...");
      const storagePath=`${user.id}/${job.id}/submitted/${submitDate}_worklog.pdf`;
      await api.uploadStorage(storagePath,pdfBlob,"application/pdf");

      // Convert to base64 for email (direct from bytes — no FileReader needed)
      const u8=new Uint8Array(pdfBytes);const ch=[];for(let i=0;i<u8.length;i+=8192)ch.push(String.fromCharCode.apply(null,u8.subarray(i,i+8192)));
      const pdfBase64=btoa(ch.join(""));

      // Save report data (with timeout)
      setWlSubmitStep("Saving report...");
      const saveP=db.saveReport({
        job_id:job.id,user_id:user.id,report_date:submitDate,status:"submitted",
        content:buildContent()
      });
      await Promise.race([saveP,new Promise((_,rej)=>setTimeout(()=>rej(new Error("Save timed out")),15000))]);

      // Build email
      const todayDisp=new Date(todayISO+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric",timeZone:tz});
      const uName=window._mdrUserName||user?.user_metadata?.full_name||user.email?.split("@")[0]||"";
      const contractorSummary=contractors.filter(c=>c.active!==false).map(c=>`<tr><td style="padding:3px 12px 3px 0;color:#888;font-size:13px;">${c.name}</td><td style="padding:3px 0;color:#333;font-size:13px;">${c.hours||0} hrs × ${c.quantity||1}</td></tr>`).join("");
      const emailHtml=`<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;"><div style="background:#e8742a;padding:20px 24px;border-radius:8px 8px 0 0;"><h1 style="color:#fff;margin:0;font-size:20px;">My Daily Reports</h1></div><div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;"><p style="color:#333;font-size:16px;margin:0 0 8px;">Hi,</p><p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 16px;">${uName} has submitted the daily work log for <strong>${job.name}</strong> on ${todayDisp}.</p><p style="color:#555;font-size:14px;margin:0 0 8px;"><strong>${contractors.length}</strong> contractor${contractors.length!==1?"s":""} — <strong>${totalHours}</strong> total hours</p>${contractorSummary?`<table style="margin:8px 0 16px;border-collapse:collapse;">${contractorSummary}</table>`:""}<p style="color:#555;font-size:14px;margin:16px 0 0;">The full PDF report is attached to this email.</p></div><p style="color:#999;font-size:11px;text-align:center;margin-top:16px;">Sent via My Daily Reports</p></div>`;

      const rawTeam=job.team_emails||[];
      const teamEmails=rawTeam.map(m=>typeof m==="string"?m:m.email).filter(Boolean);
      setSubmitSuccess({pdfBlob,pdfFilename,pdfBase64,emailHtml,teamEmails,jobName:job.name,todayDisplay:todayDisp,userName:uName});
      showToast("Report submitted!");
    }catch(e){
      console.error("Submit error:",e);
      showToast("Submit failed: "+e.message);
    }finally{setSubmitting(false);}
  };

  // Download PDF
  const downloadPdf=async()=>{
    if(!submitSuccess)return;
    const file=new File([submitSuccess.pdfBlob],submitSuccess.pdfFilename,{type:"application/pdf"});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      try{await navigator.share({files:[file],title:submitSuccess.pdfFilename});showToast("PDF shared!");return;}catch(e){if(e.name==="AbortError")return;}
    }
    const url=URL.createObjectURL(submitSuccess.pdfBlob);
    const a=document.createElement("a");a.href=url;a.download=submitSuccess.pdfFilename;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);showToast("PDF saved!");
  };

  // Email to team
  const emailToTeam=async()=>{
    if(!submitSuccess)return;
    setEmailing(true);
    try{
      const userEmail=user.email;
      const recipients=[...new Set([userEmail,...submitSuccess.teamEmails])].filter(Boolean);
      if(recipients.length===0){showToast("No team emails configured. Add them in Job Settings.");setEmailing(false);return;}
      let senderName="My Daily Reports";
      try{const prof=await db.getProfile(user.id);if(prof?.company_name)senderName=prof.company_name;}catch(e){}
      const emailBody={to:recipients,subject:`${submitSuccess.jobName} — Daily Work Log ${submitSuccess.todayDisplay}`,html_body:submitSuccess.emailHtml,pdf_base64:submitSuccess.pdfBase64,pdf_filename:submitSuccess.pdfFilename,sender_name:senderName};
      await api.sendReport(emailBody);
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

  const savingRef=useRef(false);
  const saveWorking=async()=>{
    if(savingRef.current)return; // prevent overlapping saves
    savingRef.current=true;
    setSaving(true);
    try{
      const saveDate=reportDate||new Date().toLocaleDateString("en-CA",{timeZone:tz});
      // Wrap save in a timeout so spotty network can't hang forever
      const savePromise=db.saveReport({
        job_id:job.id,user_id:user.id,report_date:saveDate,status:wlReportStatus||"working_copy",
        content:buildContent()
      });
      const timeout=new Promise((_,rej)=>setTimeout(()=>rej(new Error("Save timed out")),15000));
      await Promise.race([savePromise,timeout]);
    }catch(e){console.error("Save failed:",e);showToast&&showToast("Save failed — check connection");}
    finally{savingRef.current=false;setSaving(false);}
  };

  // Safety valve: if saving state gets stuck for >20s, force-reset it
  useEffect(()=>{
    if(!saving)return;
    const t=setTimeout(()=>{savingRef.current=false;setSaving(false);console.warn("Force-reset stuck saving state");},20000);
    return()=>clearTimeout(t);
  },[saving]);

  // Safety valve: if submitting state gets stuck for >45s, force-reset it
  useEffect(()=>{
    if(!submitting)return;
    const t=setTimeout(()=>{setSubmitting(false);console.warn("Force-reset stuck submitting state");showToast&&showToast("Submit timed out — please try again");},45000);
    return()=>clearTimeout(t);
  },[submitting]);

  // Auto-save every 30 seconds if content changed (skip after submit)
  const lastSaveHash=useRef("");
  useEffect(()=>{
    if(contractors.filter(c=>c.active!==false).length===0||submitSuccess)return;
    const t=setInterval(()=>{
      if(savingRef.current)return; // skip if save already in flight
      const hash=JSON.stringify({contractors,generalNotes,safetyNotes,materials,equipment,qualityControl,customCategories,survey,weatherAM,weatherMid,weatherPM,sectionPhotos});
      if(hash===lastSaveHash.current)return; // nothing changed
      lastSaveHash.current=hash;
      saveWorking();
    },30000);
    return()=>clearInterval(t);
  },[contractors,generalNotes,safetyNotes,materials,equipment,qualityControl,customCategories,survey,weatherEnabled,weatherAM,weatherMid,weatherPM,sectionPhotos,submitSuccess]);

  const totalHours=contractors.filter(c=>c.active!==false).reduce((sum,c)=>{
    const h=parseFloat(c.hours)||0;
    const q=parseInt(c.quantity)||1;
    return sum+h*q;
  },0);

  const active=contractors.find(c=>c.id===activeId);

  // ── Preview Screen ──
  if(viewingPreview){
    return(
      <div style={{minHeight:"100vh",background:C.bg,color:C.txt,display:"flex",flexDirection:"column"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",borderBottom:`1px solid ${C.brd}`,background:C.card}}>
          <button onClick={()=>setViewingPreview(null)} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:17}}>Report Preview</div>
            <div style={{fontSize:12,color:C.mut}}>{viewingPreview.length} page{viewingPreview.length>1?"s":""}</div>
          </div>
        </div>
        <div style={{flex:1,overflow:"auto",WebkitOverflowScrolling:"touch",padding:"12px 16px"}}>
          {viewingPreview.map((dataUrl,i)=>(
            <div key={i} style={{marginBottom:12,borderRadius:4,overflow:"hidden",boxShadow:"0 1px 6px rgba(0,0,0,0.4)"}}>
              <img src={dataUrl} style={{width:"100%",display:"block"}} alt={"Page "+(i+1)}/>
            </div>
          ))}
        </div>
        <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"14px 20px",borderTop:`1px solid ${C.brd}`,background:C.card,zIndex:100,display:"flex",gap:10}}>
          <button onClick={()=>setViewingPreview(null)} style={{flex:1,padding:"14px 0",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15,fontWeight:700,cursor:"pointer"}}>
            Back to Editing
          </button>
          <button onClick={async()=>{setViewingPreview(null);await submitWorkLog();}} disabled={submitting} style={{flex:1,padding:"14px 0",background:C.org,border:"none",borderRadius:10,color:"#fff",fontSize:15,fontWeight:700,cursor:submitting?"default":"pointer",opacity:submitting?0.7:1}}>
            {submitting?"Submitting...":"Submit Report"}
          </button>
        </div>
      </div>
    );
  }

  return(
    <div className="page-in" style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      {submitting&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:300,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
          <div style={{width:48,height:48,border:"3px solid "+C.brd,borderTopColor:C.org,borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
          <div style={{fontSize:16,fontWeight:700,color:C.txt}}>{wlSubmitStep||"Submitting..."}</div>
          <div style={{fontSize:13,color:C.mut}}>Please don't close this screen</div>
          <button onClick={()=>{savingRef.current=false;setSaving(false);setSubmitting(false);}} style={{marginTop:12,padding:"10px 24px",background:"transparent",border:`1px solid ${C.brd}`,borderRadius:8,color:C.mut,fontSize:13,cursor:"pointer"}}>Cancel</button>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}
      {/* Header */}
      <div style={{borderBottom:`1px solid ${C.brd}`,background:C.card,padding:"14px 16px"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,maxWidth:600,margin:"0 auto"}}>
        <button onClick={async()=>{await saveWorking();onBack();}} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:700,fontSize:16,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{job.name}</div>
          <div style={{fontSize:12,color:C.mut}}>Work Log — {new Date(todayISO+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",timeZone:tz})}</div>
        </div>
        <button onClick={()=>setFieldMode(!fieldMode)} title={fieldMode?"Switch to Full Editor":"Switch to Field Mode"} aria-label={fieldMode?"Switch to full editor":"Switch to field mode"} style={{width:44,height:44,borderRadius:8,background:fieldMode?C.org:C.card,border:`1px solid ${fieldMode?C.org:C.brd}`,color:fieldMode?"#fff":C.mut,fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s"}}>{fieldMode?"📋":"📱"}</button>
        <button onClick={saveWorking} disabled={saving} style={{padding:"8px 14px",background:C.blu,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:600,cursor:saving?"default":"pointer",opacity:saving?0.7:1}}>
          {saving?"Saving...":"Save"}
        </button>
      </div>
      </div>

      {/* ── Field Mode ── */}
      {fieldMode?(()=>{
        const activeCons=contractors.filter(c=>c.active!==false);
        const selCon=activeCons.find(c=>c.id===activeId)||activeCons[0]||null;
        const effectiveId=selCon?selCon.id:null;
        return(
          <div style={{maxWidth:560,margin:"0 auto",padding:"16px 16px 100px",minHeight:"calc(100vh - 60px)"}}>
            {/* Field Mode badge */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16}}>
              <span style={{background:C.org,color:"#fff",fontSize:11,fontWeight:700,borderRadius:20,padding:"4px 14px"}}>FIELD MODE</span>
            </div>

            {/* Contractor tabs */}
            {activeCons.length>0?(
              <div style={{display:"flex",gap:8,padding:"0 0 14px",overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
                {activeCons.map(c=>(
                  <button key={c.id} onClick={()=>setActiveId(c.id)} style={{padding:"10px 16px",borderRadius:8,border:"none",background:effectiveId===c.id?C.org:C.card,color:effectiveId===c.id?"#fff":C.mut,fontSize:14,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0,transition:"all 0.15s",boxShadow:effectiveId===c.id?"0 2px 8px rgba(232,116,42,0.3)":"none"}}>
                    {c.name}
                    {c.photos?.length>0&&<span style={{marginLeft:6,background:effectiveId===c.id?"rgba(255,255,255,0.3)":"rgba(232,116,42,0.15)",borderRadius:10,padding:"1px 6px",fontSize:11}}>{c.photos.length}</span>}
                  </button>
                ))}
              </div>
            ):(
              <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:20,marginBottom:16,textAlign:"center"}}>
                <div style={{fontSize:14,color:C.mut,marginBottom:12}}>No contractors yet</div>
                <div style={{display:"flex",gap:8}}>
                  <input type="text" value={fieldAddName} onChange={e=>setFieldAddName(e.target.value)} placeholder="Contractor name" onKeyDown={e=>{if(e.key==="Enter"&&fieldAddName.trim()){setContractors(p=>[...p,{id:Date.now(),name:fieldAddName.trim(),description:"",hours:0,quantity:1,photos:[],active:true}]);const newId=Date.now();setActiveId(newId);setFieldAddName("");}}} style={{flex:1,padding:"12px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:15}}/>
                  <button onClick={()=>{if(fieldAddName.trim()){const id=Date.now();setContractors(p=>[...p,{id,name:fieldAddName.trim(),description:"",hours:0,quantity:1,photos:[],active:true}]);setActiveId(id);setFieldAddName("");}}} style={{padding:"12px 20px",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Add</button>
                </div>
              </div>
            )}

            {/* Selected contractor: notes + camera + photos */}
            {selCon&&(
              <div>
                {/* Work description textarea */}
                <div style={{marginBottom:14}}>
                  <textarea value={selCon.description||""} onChange={e=>{const v=e.target.value;setContractors(p=>p.map(c=>c.id===selCon.id?{...c,description:v}:c));}} placeholder="Tap mic or type work notes..." style={{width:"100%",minHeight:220,padding:"14px 16px",background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,color:C.txt,fontSize:16,lineHeight:1.5,resize:"vertical",boxSizing:"border-box",fontFamily:"inherit"}}/>
                </div>

                {/* Hours + Quantity row */}
                <div style={{display:"flex",gap:10,marginBottom:16}}>
                  <div style={{flex:1}}>
                    <label style={{fontSize:12,color:C.mut,fontWeight:600,marginBottom:4,display:"block"}}>Hours</label>
                    <input type="number" inputMode="decimal" step="0.5" value={selCon.hours||""} onChange={e=>{const v=parseFloat(e.target.value)||0;setContractors(p=>p.map(c=>c.id===selCon.id?{...c,hours:v}:c));}} style={{width:"100%",padding:"12px 14px",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:18,fontWeight:700,textAlign:"center",boxSizing:"border-box"}}/>
                  </div>
                  <div style={{flex:1}}>
                    <label style={{fontSize:12,color:C.mut,fontWeight:600,marginBottom:4,display:"block"}}>Workers</label>
                    <input type="number" inputMode="numeric" value={selCon.quantity||""} onChange={e=>{const v=parseInt(e.target.value)||1;setContractors(p=>p.map(c=>c.id===selCon.id?{...c,quantity:v}:c));}} style={{width:"100%",padding:"12px 14px",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:18,fontWeight:700,textAlign:"center",boxSizing:"border-box"}}/>
                  </div>
                </div>

                {/* SNAP PHOTO button */}
                <button onClick={()=>{setPhotoTarget(selCon.id);setPhotoMode("camera");}} style={{width:"100%",padding:"20px 0",background:C.org,border:"none",borderRadius:14,color:"#fff",fontSize:18,fontWeight:700,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6,marginBottom:14,boxShadow:"0 4px 12px rgba(232,116,42,0.35)"}}>
                  <span style={{fontSize:36}}>📷</span>
                  <span>SNAP PHOTO</span>
                  {selCon.photos?.length>0&&<span style={{fontSize:12,opacity:0.8}}>{selCon.photos.length} photo{selCon.photos.length!==1?"s":""}</span>}
                </button>

                {/* Photo strip */}
                {selCon.photos?.length>0&&(
                  <div style={{display:"flex",gap:8,overflowX:"auto",WebkitOverflowScrolling:"touch",padding:"4px 0 14px"}}>
                    {selCon.photos.map((p,pi)=>(
                      <div key={pi} style={{position:"relative",flexShrink:0}}>
                        <img src={p.data||p} style={{width:72,height:72,objectFit:"cover",borderRadius:10,border:`2px solid ${C.brd}`}} alt=""/>
                        <button onClick={()=>{setContractors(prev=>prev.map(c=>{if(c.id!==selCon.id)return c;const ph=[...(c.photos||[])];ph.splice(pi,1);return{...c,photos:ph};}));}} style={{position:"absolute",top:-8,right:-8,width:30,height:30,borderRadius:"50%",background:C.err,border:"2px solid "+C.bg,color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0,lineHeight:1}}>✕</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Quick add another contractor */}
                {activeCons.length>0&&(
                  <div style={{marginTop:8,padding:"12px 0",borderTop:`1px solid ${C.brd}`}}>
                    <div style={{display:"flex",gap:8}}>
                      <input type="text" value={fieldAddName} onChange={e=>setFieldAddName(e.target.value)} placeholder="Add contractor..." onKeyDown={e=>{if(e.key==="Enter"&&fieldAddName.trim()){const id=Date.now();setContractors(p=>[...p,{id,name:fieldAddName.trim(),description:"",hours:0,quantity:1,photos:[],active:true}]);setActiveId(id);setFieldAddName("");}}} style={{flex:1,padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:14}}/>
                      <button onClick={()=>{if(fieldAddName.trim()){const id=Date.now();setContractors(p=>[...p,{id,name:fieldAddName.trim(),description:"",hours:0,quantity:1,photos:[],active:true}]);setActiveId(id);setFieldAddName("");}}} style={{padding:"10px 16px",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>Add</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })():null}

      {/* Field Mode bottom bar */}
      {fieldMode&&(
        <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"10px 20px",borderTop:`1px solid ${C.brd}`,background:C.card,zIndex:100}}>
          <div style={{display:"flex",gap:10,maxWidth:560,margin:"0 auto"}}>
            <button onClick={()=>{savingRef.current=false;setSaving(false);setSubmitting(false);onBack();}} style={{padding:"14px 12px",background:"transparent",border:`1px solid ${C.brd}`,borderRadius:10,color:C.mut,fontSize:13,fontWeight:600,cursor:"pointer"}}>Exit</button>
            <button onClick={async()=>{await saveWorking();showToast("Saved!");}} disabled={saving} style={{flex:1,padding:"14px 0",background:C.blu,border:"none",borderRadius:10,color:"#fff",fontSize:14,fontWeight:700,cursor:saving?"default":"pointer",opacity:saving?0.6:1}}>
              {saving?"Saving...":"Save Draft"}
            </button>
            <button onClick={submitWorkLog} disabled={submitting} style={{flex:1,padding:"14px 0",background:C.org,border:"none",borderRadius:10,color:"#fff",fontSize:14,fontWeight:700,cursor:submitting?"default":"pointer",opacity:submitting?0.6:1}}>
              {submitting?"...":"Submit"}
            </button>
          </div>
        </div>
      )}

      {/* ── Full Editor Content ── */}
      {!fieldMode&&<div style={{maxWidth:560,margin:"0 auto",padding:"20px 16px 120px"}}>

        {/* Weather — Collapsible */}
        <div style={{background:C.card,border:`1px solid ${expandedSections.weather?C.org:C.brd}`,borderRadius:12,overflow:"hidden",marginBottom:10,transition:"border-color 0.2s"}}>
          <button onClick={()=>{if(!weatherEnabled)toggleWeather(true);toggleSection("weather");}} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"14px 16px",background:"none",border:"none",cursor:"pointer",textAlign:"left"}}>
            <span style={{fontSize:16}}>☀</span>
            <span style={{flex:1,fontWeight:700,fontSize:14,color:C.txt}}>Weather</span>
            <button onClick={(ev)=>{ev.stopPropagation();toggleWeather(!weatherEnabled);}} style={{width:42,height:24,borderRadius:12,border:"none",cursor:"pointer",background:weatherEnabled?C.org:C.brd,position:"relative",flexShrink:0}}>
              <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:weatherEnabled?21:3,transition:"left 0.2s"}}/>
            </button>
            <span style={{fontSize:11,color:C.mut}}>{weatherEnabled?(weatherAM?"Has data":"Fetching..."):"Off"}</span>
            <span style={{color:expandedSections.weather?C.org:C.mut,fontSize:18,transform:expandedSections.weather?"rotate(180deg)":"none",transition:"transform 0.2s",padding:"4px 8px"}}>▼</span>
          </button>
          {expandedSections.weather&&weatherEnabled&&(
            <div style={{padding:"0 16px 16px"}}>
              {weatherLoading&&!weatherAM?(
                <div style={{textAlign:"center",padding:"16px 0",color:C.mut,fontSize:13}}>
                  <div style={{width:24,height:24,border:`2px solid ${C.brd}`,borderTop:`2px solid ${C.org}`,borderRadius:"50%",margin:"0 auto 8px",animation:"spin 1s linear infinite"}}/>
                  Fetching weather for {job.site_address}...
                </div>
              ):(
                <>
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {[{label:"Morning (7 AM)",val:weatherAM,set:setWeatherAM,icon:"🌅"},
                      {label:"Midday (12 PM)",val:weatherMid,set:setWeatherMid,icon:"☀️"},
                      {label:"Afternoon (4 PM)",val:weatherPM,set:setWeatherPM,icon:"🌇"}
                    ].map(w=>(
                      <div key={w.label} style={{display:"flex",alignItems:"center",gap:10}}>
                        <span style={{fontSize:16,flexShrink:0}}>{w.icon}</span>
                        <div style={{flex:1}}>
                          <label style={{display:"block",fontSize:10,color:C.mut,marginBottom:2}}>{w.label}</label>
                          <input type="text" value={w.val} onChange={e=>w.set(e.target.value)} placeholder="72°F Sunny, Wind 5 mph, 45% humidity" style={{...fs,padding:"8px 10px",fontSize:12}}/>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button onClick={fetchWeather} disabled={weatherLoading} style={{width:"100%",marginTop:10,padding:"8px 0",background:C.blu+"12",border:`1px solid ${C.blu}33`,borderRadius:8,color:C.blu,fontSize:12,fontWeight:600,cursor:weatherLoading?"default":"pointer",opacity:weatherLoading?0.6:1}}>
                    {weatherLoading?"Fetching...":"Refresh Weather Data"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Contractor Cards */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontWeight:700,fontSize:15}}>Contractors</span>
            <span style={{fontSize:12,color:C.mut,fontWeight:600}}>({contractors.filter(c=>c.active!==false).length}{contractors.some(c=>c.active===false)?"/"+contractors.length:""})</span>
          </div>
          {totalHours>0&&(
            <span style={{fontSize:12,fontWeight:700,color:C.org}}>{totalHours} total hrs</span>
          )}
        </div>

        {contractors.map(c=>{
          const isActive=c.active!==false;
          return(
          <div key={c.id} style={{background:C.card,border:`1px solid ${activeId===c.id?C.org:C.brd}`,borderRadius:12,marginBottom:10,overflow:"hidden",transition:"border-color 0.2s",opacity:isActive?1:0.45}}>
            {/* Contractor name bar — tap to expand/collapse */}
            <button onClick={()=>isActive&&setActiveId(activeId===c.id?null:c.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"14px 16px",background:"none",border:"none",cursor:isActive?"pointer":"default",textAlign:"left"}}>
              {/* On/Off toggle */}
              <div onClick={e=>{e.stopPropagation();updateContractor(c.id,"active",!isActive);if(!isActive)setActiveId(null);}} style={{width:40,height:22,borderRadius:11,background:isActive?C.ok:C.brd,position:"relative",cursor:"pointer",flexShrink:0,transition:"background 0.2s"}}>
                <div style={{width:18,height:18,borderRadius:9,background:"#fff",position:"absolute",top:2,left:isActive?20:2,transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"}}/>
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{fontSize:14,fontWeight:700,color:isActive?C.txt:C.mut,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{c.name}</div>
                  {!isActive&&<span style={{fontSize:10,fontWeight:700,color:C.mut,background:C.inp,borderRadius:4,padding:"2px 6px"}}>Not on site</span>}
                  {isActive&&c.locked&&<span style={{fontSize:10,fontWeight:700,color:C.org,background:C.org+"18",borderRadius:4,padding:"2px 6px"}}>Carries Over</span>}
                </div>
                <div style={{fontSize:11,color:C.mut}}>
                  {isActive?(c.hours?`${c.hours} hrs`:"No hours")+" · "+(c.quantity||1)+" "+(parseInt(c.quantity||1)===1?"person":"people"):"Toggled off — will not appear in report"}
                  {isActive&&(c.photos||[]).length>0&&` · ${c.photos.length} photo${c.photos.length>1?"s":""}`}
                </div>
              </div>
              {isActive&&<span style={{color:activeId===c.id?C.org:C.mut,fontSize:18,transform:activeId===c.id?"rotate(180deg)":"none",transition:"transform 0.2s",padding:"4px 8px"}}>▼</span>}
            </button>

            {/* Expanded entry area */}
            {activeId===c.id&&(
              <div style={{padding:"0 16px 16px",borderTop:`1px solid ${C.brd}`,position:"relative"}}>
                {/* Top bar: Save/Close + Remove */}
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0 6px"}}>
                  <button onClick={()=>removeContractor(c.id)} style={{background:"none",border:"none",color:C.err,fontSize:11,fontWeight:600,cursor:"pointer",padding:"4px 8px",opacity:0.7}}>✕ Remove</button>
                  <button onClick={()=>setActiveId(null)} style={{display:"flex",alignItems:"center",gap:5,padding:"6px 14px",background:"#22c55e",border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>✓ Save</button>
                </div>
                <div style={{marginBottom:14}}>
                  <label style={{display:"block",fontSize:12,color:C.lt,fontWeight:600,marginBottom:4}}>Work Description</label>
                  <textarea value={c.description} onChange={e=>updateContractor(c.id,"description",e.target.value)} placeholder="Tap here and use your keyboard mic to dictate..." rows={3} style={{...fs,resize:"vertical",minHeight:70,lineHeight:1.5}}/>
                </div>
                <div style={{display:"flex",gap:10,marginBottom:14}}>
                  <div style={{flex:1}}>
                    <label style={{display:"block",fontSize:12,color:C.lt,fontWeight:600,marginBottom:4}}>Total Hours</label>
                    <input type="number" inputMode="decimal" value={c.hours} onChange={e=>updateContractor(c.id,"hours",e.target.value)} placeholder="8" style={fs}/>
                  </div>
                  <div style={{flex:1}}>
                    <label style={{display:"block",fontSize:12,color:C.lt,fontWeight:600,marginBottom:4}}>Quantity (Men)</label>
                    <input type="number" inputMode="numeric" value={c.quantity} onChange={e=>updateContractor(c.id,"quantity",e.target.value)} placeholder="1" style={fs}/>
                  </div>
                </div>

                {/* Photos for this contractor */}
                <div style={{marginBottom:14}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <label style={{fontSize:12,color:C.lt,fontWeight:600}}>Photos ({(c.photos||[]).length})</label>
                  </div>
                  {(c.photos||[]).length>0&&(
                    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                      {c.photos.map((ph,i)=>{const aiKey="c-"+c.id+"-"+i;return(
                        <div key={i} style={{width:72,height:72,borderRadius:8,overflow:"hidden",position:"relative",border:`1px solid ${C.brd}`}}>
                          <img src={ph.data} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                          <button onClick={()=>removePhoto(c.id,i)} style={{position:"absolute",top:2,right:2,width:30,height:30,borderRadius:"50%",background:"rgba(0,0,0,0.6)",border:"none",color:"#fff",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                          {job.field_config?.aiPhotos&&<button disabled={aiDescribing[aiKey]||aiLimitReached} onClick={async()=>{const desc=await describePhoto(ph.data,`Contractor: ${c.name}, Job: ${job?.name||""}`,aiKey);if(desc)updateContractor(c.id,"description",(c.description?c.description+"\n":"")+desc);}} style={{position:"absolute",bottom:2,left:2,padding:"2px 5px",borderRadius:4,background:aiLimitReached?"#666":aiDescribing[aiKey]?C.blu:C.org,border:"none",color:"#fff",fontSize:9,fontWeight:700,cursor:aiDescribing[aiKey]?"wait":aiLimitReached?"not-allowed":"pointer",opacity:aiDescribing[aiKey]||aiLimitReached?0.7:0.9}}>{aiDescribing[aiKey]?"···":aiLimitReached?"—":"AI"}</button>}
                        </div>
                      );})}
                    </div>
                  )}
                  {/* Photo + Library buttons */}
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{setPhotoTarget(c.id);setPhotoMode("camera");}} style={{flex:1,padding:"10px 0",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer"}}>Photo</button>
                    <button onClick={()=>{setPhotoTarget(c.id);setPhotoMode("library");}} style={{flex:1,padding:"10px 0",background:C.card,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,fontSize:13,fontWeight:600,cursor:"pointer"}}>Library</button>
                  </div>
                </div>

                {/* Carry-over toggle — at the very bottom */}
                <div style={{padding:"10px 12px",background:C.org+"0A",border:`1px solid ${C.org}22`,borderRadius:8}}>
                  <div style={{fontSize:12,fontWeight:600,color:C.lt,marginBottom:6}}>Carry over to tomorrow:</div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{updateContractor(c.id,"locked",true);updateContractor(c.id,"carryDesc",true);}} style={{flex:1,padding:"8px 0",background:c.locked&&c.carryDesc!==false?C.org:C.card,border:`1px solid ${c.locked&&c.carryDesc!==false?C.org:C.brd}`,borderRadius:6,color:c.locked&&c.carryDesc!==false?"#fff":C.mut,fontSize:12,fontWeight:600,cursor:"pointer"}}>Name + Work</button>
                    <button onClick={()=>{updateContractor(c.id,"locked",true);updateContractor(c.id,"carryDesc",false);}} style={{flex:1,padding:"8px 0",background:c.locked&&c.carryDesc===false?C.org:C.card,border:`1px solid ${c.locked&&c.carryDesc===false?C.org:C.brd}`,borderRadius:6,color:c.locked&&c.carryDesc===false?"#fff":C.mut,fontSize:12,fontWeight:600,cursor:"pointer"}}>Name Only</button>
                    {c.locked&&<button onClick={()=>{updateContractor(c.id,"locked",false);updateContractor(c.id,"carryDesc",true);}} style={{padding:"8px 12px",background:"transparent",border:`1px solid ${C.brd}`,borderRadius:6,color:C.mut,fontSize:12,fontWeight:600,cursor:"pointer"}}>Clear</button>}
                  </div>
                </div>
              </div>
            )}
          </div>
        );})}

        {/* Add Contractor */}
        {showAdd?(
          <div style={{background:C.card,border:`2px solid ${C.org}`,borderRadius:12,padding:16,marginBottom:16}}>
            <label style={{display:"block",fontSize:13,color:C.lt,fontWeight:600,marginBottom:6}}>Contractor Name</label>
            <div style={{display:"flex",gap:8}}>
              <input type="text" value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addContractor();}} placeholder="e.g. ABC Electric" autoFocus style={{...fs,flex:1}}/>
              <button onClick={addContractor} disabled={!newName.trim()} style={{padding:"12px 20px",background:newName.trim()?C.org:C.brd,border:"none",borderRadius:10,color:"#fff",fontSize:14,fontWeight:700,cursor:newName.trim()?"pointer":"default"}}>Add</button>
            </div>
            <button onClick={()=>{setShowAdd(false);setNewName("");}} style={{width:"100%",marginTop:8,padding:"8px 0",background:"transparent",border:"none",color:C.mut,fontSize:13,cursor:"pointer"}}>Cancel</button>
          </div>
        ):(
          <button onClick={()=>setShowAdd(true)} style={{width:"100%",padding:"14px 0",background:C.card,border:`2px dashed ${C.brd}`,borderRadius:12,color:C.org,fontSize:15,fontWeight:700,cursor:"pointer",marginBottom:16}}>
            + Add Contractor
          </button>
        )}

        {/* ── Collapsible Report Sections ── */}
        {[
          {key:"materials",icon:"🧱",title:"Materials",val:materials,set:setMaterials,placeholder:"Materials used or delivered today..."},
          {key:"equipment",icon:"🚜",title:"Equipment",val:equipment,set:setEquipment,placeholder:"Equipment on site or rented..."},
          {key:"generalNotes",icon:"📝",title:"General Notes",val:generalNotes,set:setGeneralNotes,placeholder:"Tap here and use your keyboard mic to dictate..."},
          {key:"safetyNotes",icon:"🦺",title:"Site Safety Observations",val:safetyNotes,set:setSafetyNotes,placeholder:"Safety observations, incidents, precautions..."},
          {key:"qualityControl",icon:"✅",title:"Quality Control Observations",val:qualityControl,set:setQualityControl,placeholder:"Quality control notes, observations..."},
        ].map(sec=>(
          <div key={sec.key} style={{background:C.card,border:`1px solid ${expandedSections[sec.key]?C.org:C.brd}`,borderRadius:12,marginBottom:10,overflow:"hidden",transition:"border-color 0.2s"}}>
            <button onClick={()=>toggleSection(sec.key)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"14px 16px",background:"none",border:"none",cursor:"pointer",textAlign:"left"}}>
              <span style={{fontSize:16}}>{sec.icon}</span>
              <span style={{flex:1,fontWeight:700,fontSize:14,color:C.txt}}>{sec.title}</span>
              <span style={{fontSize:11,color:C.mut}}>{sec.val?"Has entry":"No entry"}</span>
              <span style={{color:expandedSections[sec.key]?C.org:C.mut,fontSize:18,transform:expandedSections[sec.key]?"rotate(180deg)":"none",transition:"transform 0.2s",padding:"4px 8px"}}>▼</span>
            </button>
            {expandedSections[sec.key]&&(
              <div style={{padding:"0 16px 16px"}}>
                <textarea value={sec.val} onChange={e=>sec.set(e.target.value)} placeholder={sec.placeholder} rows={3} style={{...fs,resize:"vertical",minHeight:70,lineHeight:1.5}}/>
                {(sectionPhotos[sec.key]||[]).length>0&&<div style={{fontSize:11,color:C.mut,marginTop:8}}>{(sectionPhotos[sec.key]||[]).length} photo{(sectionPhotos[sec.key]||[]).length!==1?"s":""}</div>}
                <div style={{display:"flex",gap:8,marginTop:8}}>
                  <button onClick={()=>{setSectionPhotoTarget(sec.key);setSectionPhotoMode("camera");}} style={{flex:1,padding:"10px 0",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer"}}>Photo</button>
                  <button onClick={()=>{setSectionPhotoTarget(sec.key);setSectionPhotoMode("library");}} style={{flex:1,padding:"10px 0",background:C.card,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,fontSize:13,fontWeight:600,cursor:"pointer"}}>Library</button>
                </div>
                {(sectionPhotos[sec.key]||[]).length>0&&(
                  <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
                    {(sectionPhotos[sec.key]||[]).map((ph,pi)=>{const aiKey="s-"+sec.key+"-"+pi;return(
                      <div key={pi} style={{position:"relative",width:60,height:60,borderRadius:6,overflow:"hidden",border:`1px solid ${C.brd}`}}>
                        <img src={ph.data} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                        <button onClick={()=>removeSectionPhoto(sec.key,pi)} style={{position:"absolute",top:2,right:2,background:"rgba(0,0,0,0.6)",border:"none",color:"#fff",fontSize:13,width:28,height:28,borderRadius:"50%",cursor:"pointer",lineHeight:1,padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                        {job.field_config?.aiPhotos&&<button disabled={aiDescribing[aiKey]||aiLimitReached} onClick={async()=>{const desc=await describePhoto(ph.data,`Section: ${sec.title}, Job: ${job?.name||""}`,aiKey);if(desc)sec.set((sec.val?sec.val+"\n":"")+desc);}} style={{position:"absolute",bottom:1,left:1,padding:"1px 4px",borderRadius:3,background:aiLimitReached?"#666":aiDescribing[aiKey]?C.blu:C.org,border:"none",color:"#fff",fontSize:8,fontWeight:700,cursor:aiDescribing[aiKey]?"wait":aiLimitReached?"not-allowed":"pointer",opacity:aiDescribing[aiKey]||aiLimitReached?0.7:0.9}}>{aiDescribing[aiKey]?"···":aiLimitReached?"—":"AI"}</button>}
                      </div>
                    );})}
                  </div>
                )}
                {/* Carry-over toggle — matches contractor pattern */}
                <div style={{marginTop:12,padding:"10px 12px",background:C.org+"0A",border:`1px solid ${C.org}22`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{fontSize:12,fontWeight:600,color:C.lt}}>Carry over to tomorrow</span>
                  <button onClick={()=>setSectionCarry(p=>({...p,[sec.key]:!p[sec.key]}))} style={{width:44,height:24,borderRadius:12,background:sectionCarry[sec.key]?C.org:C.inp,border:`1px solid ${sectionCarry[sec.key]?C.org:C.brd}`,cursor:"pointer",position:"relative",transition:"background 0.2s",padding:0}}>
                    <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:sectionCarry[sec.key]?22:3,transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"}}/>
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Custom Categories — user-added sections */}
        {customCategories.map((cat,ci)=>(
          <div key={"cc-"+ci} style={{background:C.card,border:`1px solid ${expandedSections["cc"+ci]?C.org:C.brd}`,borderRadius:12,marginBottom:10,overflow:"hidden",transition:"border-color 0.2s"}}>
            <button onClick={()=>toggleSection("cc"+ci)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"14px 16px",background:"none",border:"none",cursor:"pointer",textAlign:"left"}}>
              <span style={{fontSize:16}}>+</span>
              <span style={{flex:1,fontWeight:700,fontSize:14,color:C.txt}}>{cat.title||"New Category"}</span>
              <span style={{fontSize:11,color:C.mut}}>{cat.value?"Has entry":"No entry"}</span>
              <button onClick={e=>{e.stopPropagation();setCustomCategories(p=>p.filter((_,i)=>i!==ci));}} style={{background:"none",border:"none",color:"#ef4444",fontSize:14,cursor:"pointer",padding:"4px 8px"}}>✕</button>
              <span style={{color:expandedSections["cc"+ci]?C.org:C.mut,fontSize:18,transform:expandedSections["cc"+ci]?"rotate(180deg)":"none",transition:"transform 0.2s",padding:"4px 8px"}}>▼</span>
            </button>
            {expandedSections["cc"+ci]&&(
              <div style={{padding:"0 16px 16px"}}>
                <input value={cat.title} onChange={e=>setCustomCategories(p=>p.map((c,i)=>i===ci?{...c,title:e.target.value}:c))} placeholder="Category name..." style={{...fs,padding:"8px 12px",marginBottom:8,fontWeight:600}}/>
                <textarea value={cat.value} onChange={e=>setCustomCategories(p=>p.map((c,i)=>i===ci?{...c,value:e.target.value}:c))} placeholder="Enter details..." rows={3} style={{...fs,resize:"vertical",minHeight:70,lineHeight:1.5}}/>
              </div>
            )}
          </div>
        ))}

        {/* Add Category button */}
        <button onClick={()=>{const idx=customCategories.length;setCustomCategories(p=>[...p,{title:"",value:""}]);setExpandedSections(p=>({...p,["cc"+idx]:true}));}} style={{width:"100%",padding:"12px 0",background:"none",border:`1px dashed ${C.brd}`,borderRadius:12,color:C.mut,fontSize:13,fontWeight:600,cursor:"pointer",marginBottom:10}}>
          + Add Category
        </button>

        {/* Survey Section */}
        <div style={{background:C.card,border:`1px solid ${expandedSections.survey?C.org:C.brd}`,borderRadius:12,marginBottom:10,overflow:"hidden",transition:"border-color 0.2s"}}>
          <button onClick={()=>toggleSection("survey")} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"14px 16px",background:"none",border:"none",cursor:"pointer",textAlign:"left"}}>
            <span style={{fontSize:16}}>📋</span>
            <span style={{flex:1,fontWeight:700,fontSize:14,color:C.txt}}>Survey</span>
            <span style={{fontSize:11,color:C.mut}}>{survey.some(s=>s.answer)?"Answered":"No entry"}</span>
            <span style={{color:expandedSections.survey?C.org:C.mut,fontSize:18,transform:expandedSections.survey?"rotate(180deg)":"none",transition:"transform 0.2s",padding:"4px 8px"}}>▼</span>
          </button>
          {expandedSections.survey&&(
            <div style={{padding:"0 16px 16px"}}>
              {survey.map((s,si)=>(
                <div key={si} style={{padding:"10px 0",borderTop:si>0?`1px solid ${C.brd}`:"none"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
                    {si<6?(
                      <div style={{flex:1,fontSize:13,fontWeight:600,color:C.txt}}>{si+1}. {s.q}</div>
                    ):(
                      <input value={s.q} onChange={e=>setSurvey(p=>p.map((sv,i)=>i===si?{...sv,q:e.target.value}:sv))} placeholder="Type your concern..." style={{flex:1,fontSize:13,fontWeight:600,color:C.txt,background:C.inp,border:`1px solid ${C.brd}`,borderRadius:6,padding:"6px 10px"}}/>
                    )}
                    {si>=6&&<button onClick={()=>setSurvey(p=>p.filter((_,i)=>i!==si))} style={{background:"none",border:"none",color:"#ef4444",fontSize:12,cursor:"pointer",padding:"2px 6px"}}>✕</button>}
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:6}}>
                    {["N/A","No","Yes"].map(opt=>(
                      <button key={opt} onClick={()=>setSurvey(p=>p.map((sv,i)=>i===si?{...sv,answer:sv.answer===opt?"":opt}:sv))}
                        style={{flex:1,padding:"8px 0",borderRadius:8,border:`1px solid ${s.answer===opt?C.org:C.brd}`,background:s.answer===opt?C.org+"18":"none",color:s.answer===opt?C.org:C.mut,fontSize:13,fontWeight:600,cursor:"pointer"}}>
                        {opt}
                      </button>
                    ))}
                  </div>
                  {s.answer==="Yes"&&(
                    <input value={s.desc||""} onChange={e=>setSurvey(p=>p.map((sv,i)=>i===si?{...sv,desc:e.target.value}:sv))} placeholder="Description..." style={{...fs,padding:"8px 12px"}}/>
                  )}
                </div>
              ))}
              <button onClick={()=>setSurvey(p=>[...p,{q:"",answer:"",desc:""}])} style={{width:"100%",padding:"10px 0",background:"none",border:`1px dashed ${C.brd}`,borderRadius:8,color:C.mut,fontSize:13,fontWeight:600,cursor:"pointer",marginTop:8}}>
                + Add Concern
              </button>
            </div>
          )}
        </div>

      </div>}

      {/* Hidden photo inputs — separate for camera vs library */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={handlePhotoUpload}/>
      <input ref={libraryRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handlePhotoUpload}/>
      <input ref={sectionPhotoRef} type="file" accept="image/*" capture="environment" multiple style={{display:"none"}} onChange={handleSectionPhoto}/>
      <input ref={sectionLibraryRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handleSectionPhoto}/>

      {/* Toast */}
      {toast&&<div style={{position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",background:C.card,border:`1px solid ${C.ok}`,borderRadius:10,padding:"10px 20px",fontSize:14,fontWeight:600,color:C.ok,zIndex:9999}}>{toast}</div>}

      {/* Post-submit overlay */}
      {submitSuccess&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:16,padding:24,maxWidth:400,width:"100%",textAlign:"center"}}>
            <div style={{fontSize:48,marginBottom:12}}>✅</div>
            <div style={{fontSize:18,fontWeight:700,color:C.txt,marginBottom:6}}>Report Submitted</div>
            <input type="text" value={submitSuccess.pdfFilename} onChange={e=>setSubmitSuccess(p=>({...p,pdfFilename:e.target.value}))} style={{width:"100%",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,padding:"8px 10px",fontSize:13,color:C.lt,textAlign:"center",marginBottom:20,outline:"none"}} onClick={e=>e.target.select()}/>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <button onClick={downloadPdf} style={{width:"100%",padding:"14px 0",background:C.blu,border:"none",borderRadius:10,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer"}}>
                Download / Share PDF
              </button>
              <button onClick={emailToTeam} disabled={emailing} style={{width:"100%",padding:"14px 0",background:C.org,border:"none",borderRadius:10,color:"#fff",fontSize:15,fontWeight:700,cursor:emailing?"default":"pointer",opacity:emailing?0.7:1}}>
                {emailing?"Sending...":"Email to Project Team"}
              </button>
              {emailing&&<div style={{fontSize:11,color:C.mut,textAlign:"center",marginTop:4}}>Emails may take up to 5 minutes to arrive. Do not resend.</div>}
              <button onClick={()=>{setSubmitSuccess(null);onBack();}} style={{width:"100%",padding:"12px 0",background:"transparent",border:`1px solid ${C.brd}`,borderRadius:10,color:C.mut,fontSize:14,fontWeight:600,cursor:"pointer"}}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom bar (full editor only) */}
      {!fieldMode&&(
      <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"10px 20px",borderTop:`1px solid ${C.brd}`,background:C.card,zIndex:100}}>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <button disabled={saving} onClick={async()=>{if(saving)return;await saveWorking();onBack();}} style={{flex:1,padding:"12px 0",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:14,fontWeight:700,cursor:saving?"default":"pointer",opacity:saving?0.7:1}}>
            {saving?"Saving…":"Save & Close"}
          </button>
          <button onClick={viewWorkLog} disabled={viewLoading||submitting||contractors.filter(c=>c.active!==false).length===0} style={{flex:1,padding:"12px 0",background:"transparent",border:`1px solid ${C.brd}`,borderRadius:10,color:C.lt,fontSize:14,fontWeight:700,cursor:viewLoading?"default":"pointer",opacity:viewLoading?0.6:1}}>
            {viewLoading?"Loading...":"View Report"}
          </button>
        </div>
        <button onClick={submitWorkLog} disabled={submitting||contractors.filter(c=>c.active!==false).length===0} style={{width:"100%",padding:"12px 0",background:contractors.filter(c=>c.active!==false).length>0?C.org:C.brd,border:"none",borderRadius:10,color:"#fff",fontSize:15,fontWeight:700,cursor:contractors.filter(c=>c.active!==false).length>0&&!submitting?"pointer":"default",opacity:submitting?0.7:1}}>
          {submitting?"Generating PDF...":"Submit Report"}
        </button>
      </div>
      )}
    </div>
  );
}

/* ── Report Editor ── */

export default WorkLogEditor;
