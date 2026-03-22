import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { C, SL } from '../constants/theme';
import { db } from '../utils/db';
import { AUTH_TOKEN, refreshAuthToken, extractPdfTextStructure } from '../utils/auth';
import { api } from '../utils/api';
import { SB_URL, SB_KEY, TYR_COMPANY_ID } from '../constants/supabase';
import { ensurePdfLib, ensurePdfJs } from '../utils/pdf';
import WorkLogEditor from './WorkLogEditor';
import ReportEditor from './ReportEditor';
import TemplateFieldEditor from './TemplateFieldEditor';
import { askConfirm } from './ConfirmOverlay';

function JobDetail({job, user, onBack, onDeleted}){
  const [jdToast,setJdToast]=useState("");
  const showToast=(msg)=>{setJdToast(msg);setTimeout(()=>setJdToast(""),3000);};
  const [showDel,setShowDel]=useState(false);
  const [deleting,setDeleting]=useState(false);
  const [showJobSet,setShowJobSet]=useState(false);
  const [reparsing,setReparsing]=useState(false);
  const reuploadRef=useRef(null);
  const [reuploading,setReuploading]=useState(false);
  const jobLogoInputRef=useRef(null);
  const [jobLogoUrl,setJobLogoUrl]=useState(job.logo_url||null);
  const [jobLogoUploading,setJobLogoUploading]=useState(false);
  const handleReuploadTemplate=async(e)=>{
    const f=e.target.files?.[0];if(!f)return;
    const ext=f.name.split(".").pop().toLowerCase();
    if(!["pdf","docx","doc","jpg","jpeg","png"].includes(ext)){showToast("Accepted formats: PDF, DOCX, JPG, PNG");return;}
    setReuploading(true);
    try{
      const blob=new Blob([await f.arrayBuffer()],{type:f.type||"application/octet-stream"});
      const sp=await db.ulTpl(user.id,job.id,blob,ext);
      // Check if template record exists, update or create
      const existing=await db.getTemplate(job.id);
      if(existing){
        await api.rest.patchTemplate(existing.id,{storage_path:sp,original_filename:f.name,file_type:ext});
      }else{
        await db.mkTpl({user_id:user.id,job_id:job.id,name:f.name,original_filename:f.name,file_type:ext,storage_path:sp,field_config:[]});
      }
      setTplFilename(f.name);
      showToast("Template uploaded successfully!");
    }catch(err){showToast("Upload failed — try again");}
    finally{setReuploading(false);if(reuploadRef.current)reuploadRef.current.value="";}
  };
  const reparseTemplate=async()=>{
    setReparsing(true);
    try{
      const tpl=await db.getTemplate(job.id);
      if(!tpl||!tpl.storage_path){showToast("No template found for this job.");return;}
      if(!AUTH_TOKEN){showToast("Authentication required to download template");return;}
      // Try downloading from multiple storage locations
      const authHeaders={apikey:SB_KEY,Authorization:`Bearer ${AUTH_TOKEN}`};
      const sp=tpl.storage_path;
      const isCompany=sp.startsWith("company-templates/");
      const urls=[];
      if(isCompany){const p=sp.replace("company-templates/","");urls.push(`${SB_URL}/storage/v1/object/company-templates/${p}`,`${SB_URL}/storage/v1/object/public/company-templates/${p}`);}
      else{urls.push(`${SB_URL}/storage/v1/object/report-source-docs/${sp}`,`${SB_URL}/storage/v1/object/company-templates/${sp}`,`${SB_URL}/storage/v1/object/public/company-templates/${sp}`);}
      let tplResp=null;
      for(const u of urls){tplResp=await fetch(u,{headers:authHeaders});if(tplResp.ok)break;}
      if(!tplResp||!tplResp.ok)throw new Error("Could not download template file.");
      const buf=await tplResp.arrayBuffer();
      // Extract real text positions client-side with pdf.js
      const textItems=await extractPdfTextStructure(new Uint8Array(buf));
      if(!textItems||textItems.length===0)throw new Error("No extractable text found in this PDF.");
      const parsed=await api.parseTemplate({text_items:textItems,file_name:tpl.original_filename||"template.pdf"});
      const coords=(f)=>({page:f.page,x:f.x,y:f.y,w:f.w,h:f.h,fontSize:f.fontSize,multiline:f.multiline});
      const editF=(parsed.editable||[]).map(f=>({name:f.name,value:f.value||"",originalValue:f.value||"",voiceEnabled:f.voiceEnabled||false,autoFill:f.autoFill||null,...coords(f)}));
      const lockF=(parsed.locked||[]).map(f=>({name:f.name,value:f.value||"",...coords(f)}));
      const newConfig={editable:editF,locked:lockF};
      await db.updateJobFieldConfig(job.id,newConfig);
      // Update the job object directly so next ReportEditor open picks up new fields
      job.field_config=newConfig;
      // Open the field editing panel so user can review/adjust the re-parsed fields
      const allFields=[...editF.map(f=>({...f,mode:f.autoFill==="date"?"auto-date":f.autoFill==="increment"?"auto-num":"edit"})),...lockF.map(f=>({...f,mode:"lock"}))];
      setFieldEditFields(allFields);
      setShowFieldEdit(true);
      setShowJobSet(true);
      showToast("Template re-parsed! Review the fields below.");
    }catch(e){console.error("Reparse error:",e);showToast("Re-parse failed: "+e.message);}
    finally{setReparsing(false);}
  };
  const [rpts,setRpts]=useState([]);
  const [loading,setLoading]=useState(true);
  const [showCompleted,setShowCompleted]=useState(false);
  const [showWorking,setShowWorking]=useState(false);
  const [showPhotos,setShowPhotos]=useState(false);
  const [showEditJob,setShowEditJob]=useState(false);
  const [showReport,setShowReport]=useState(false);
  const [showTeam,setShowTeam]=useState(false);
  const [editName,setEditName]=useState(job.name||"");
  const [editAddr,setEditAddr]=useState(job.site_address||"");
  const [editSaving,setEditSaving]=useState(false);
  const [teamMembers,setTeamMembers]=useState((job.team_emails||[]).map(e=>typeof e==="string"?{name:"",email:e}:e));
  const [newMemberName,setNewMemberName]=useState("");
  const [newMemberEmail,setNewMemberEmail]=useState("");
  const [teamSaving,setTeamSaving]=useState(false);
  const [schedContacts,setSchedContacts]=useState((job.scheduling_contacts||[]).map(e=>typeof e==="string"?{name:"",email:e}:e));
  const [newSchedName,setNewSchedName]=useState("");
  const [newSchedEmail,setNewSchedEmail]=useState("");
  const [schedContactsSaving,setSchedContactsSaving]=useState(false);
  const [showSchedContacts,setShowSchedContacts]=useState(false);
  const [showSchedSet,setShowSchedSet]=useState(false);
  const [schedEnabled,setSchedEnabled]=useState(!!job.scheduling_enabled);
  const [schedSaving,setSchedSaving]=useState(false);
  const [showFreqSet,setShowFreqSet]=useState(false);
  // Parse current schedule into editable state
  const initSched=job.schedule||"as_needed";
  const initDays=job.schedule_days||[];
  const [jdSched,setJdSched]=useState(initSched==="custom"?"custom":initSched==="daily_mf"?"custom":initSched==="daily_7"?"custom":initSched);
  const [jdDays,setJdDays]=useState(initSched==="daily_mf"?["Mon","Tue","Wed","Thu","Fri"]:initSched==="daily_7"?["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]:initDays);
  const [jdRemOn,setJdRemOn]=useState(!!job.reminder_enabled);
  const [jdRemT,setJdRemT]=useState(job.reminder_time||"5:00 PM");
  const [jdRemH,setJdRemH]=useState(job.reminder_hours_before||2);
  const [freqSaving,setFreqSaving]=useState(false);
  const jdTogDay=(d)=>{setJdSched("custom");setJdDays(p=>p.includes(d)?p.filter(x=>x!==d):[...p,d]);};
  const jdPreset=(p)=>{setJdSched(p);setJdDays([]);if(p==="as_needed")setJdRemOn(false);};
  const jdEffSch=()=>{if(jdSched==="weekly"||jdSched==="as_needed")return jdSched;if(jdDays.length===5&&["Mon","Tue","Wed","Thu","Fri"].every(d=>jdDays.includes(d))&&!jdDays.includes("Sat")&&!jdDays.includes("Sun"))return"daily_mf";if(jdDays.length===7)return"daily_7";if(jdDays.length>0)return"custom";return jdSched||"as_needed";};
  const [jdSlug,setJdSlug]=useState("");
  useEffect(()=>{db.getProfile(user.id).then(p=>{if(p?.slug)setJdSlug(p.slug);}).catch(()=>{});},[user.id]);
  const [showFieldEdit,setShowFieldEdit]=useState(false);
  const [fieldEditFields,setFieldEditFields]=useState(null); // null=not loaded
  const [fieldEditSaving,setFieldEditSaving]=useState(false);
  const [showVisualFieldEditor,setShowVisualFieldEditor]=useState(false);
  const [visualEditorB64,setVisualEditorB64]=useState(null);

  const [tplFilename,setTplFilename]=useState(null);
  // ── TYR v3: Contractor management (only for TYR jobs) ──
  const isTYR=job.company_id===TYR_COMPANY_ID;
  const [showContractors,setShowContractors]=useState(false);
  const [jobContractors,setJobContractors]=useState([]);
  const [newContractorName,setNewContractorName]=useState("");
  const [newContractorTrade,setNewContractorTrade]=useState("");
  const [contractorsSaving,setContractorsSaving]=useState(false);
  const [showGeneralStmt,setShowGeneralStmt]=useState(false);
  const [generalStmt,setGeneralStmt]=useState(job.general_statement||"");
  const [generalStmtSaving,setGeneralStmtSaving]=useState(false);
  const loadContractors=useCallback(async()=>{
    if(!isTYR)return;
    try{const c=await db.getJobContractors(job.id);setJobContractors(c);}catch(e){console.error("Load contractors:",e);}
  },[job.id,isTYR]);
  useEffect(()=>{if(isTYR)loadContractors();},[isTYR,loadContractors]);

  const loadReports=useCallback(async()=>{
    try{
      const r=await fetch(`${SB_URL}/rest/v1/reports?select=id,job_id,report_date,report_number,status,updated_at&job_id=eq.${job.id}&order=report_date.desc&limit=90`,{headers:db._h()});
      if(r.ok)setRpts(await r.json());
    }catch(e){console.error(e);}
    finally{setLoading(false);}
  },[job.id]);
  const loadTplFilename=useCallback(async()=>{
    try{const t=await db.getTemplate(job.id);if(t&&t.original_filename)setTplFilename(t.original_filename);}catch(e){}
  },[job.id]);

  useEffect(()=>{loadReports();loadTplFilename();},[loadReports,loadTplFilename]);

  const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today=new Date().toLocaleDateString("en-CA",{timeZone:tz});

  // Auto-create report stubs for scheduled days with no report
  const autoCreatedRef=useRef(false);
  useEffect(()=>{
    if(loading||autoCreatedRef.current)return;
    const sched=job.schedule||"as_needed";
    if(sched==="as_needed")return;
    // Determine which days of week are scheduled
    const dayMap={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
    let scheduledDOW=[];
    if(sched==="daily_7")scheduledDOW=[0,1,2,3,4,5,6];
    else if(sched==="daily_mf")scheduledDOW=[1,2,3,4,5];
    else if(sched==="custom"&&job.schedule_days?.length)scheduledDOW=job.schedule_days.map(d=>dayMap[d]).filter(n=>n!=null);
    else return; // weekly or unknown — skip auto-create
    if(scheduledDOW.length===0)return;
    // Find existing report dates
    const existingDates=new Set(rpts.map(r=>r.report_date));
    // Walk from 30 days ago (or job created_at) to today
    const startDate=new Date();
    startDate.setDate(startDate.getDate()-30);
    if(job.created_at){const jc=new Date(job.created_at);if(jc>startDate)startDate.setTime(jc.getTime());}
    const todayD=new Date(today+"T12:00:00");
    const missing=[];
    const cur=new Date(startDate);cur.setHours(12,0,0,0);
    while(cur<=todayD){
      const dow=cur.getDay();
      if(scheduledDOW.includes(dow)){
        const ds=cur.toLocaleDateString("en-CA",{timeZone:tz});
        if(!existingDates.has(ds))missing.push(ds);
      }
      cur.setDate(cur.getDate()+1);
    }
    if(missing.length===0)return;
    autoCreatedRef.current=true;
    // Create stubs in background
    (async()=>{
      for(const dt of missing){
        try{await db.saveReport({job_id:job.id,user_id:user.id,report_date:dt,status:"working",content:{}});}catch(e){console.warn("Auto-create stub failed for",dt,e);}
      }
      loadReports(); // Refresh to show new stubs
    })();
  },[loading,rpts,job,user.id,today,tz,loadReports]);
  const todayRpt=rpts.find(r=>r.report_date===today);
  const submitted=rpts.filter(r=>r.status==="submitted");
  const working=rpts.filter(r=>r.status!=="submitted");
  const nextNum=submitted.length+working.length+1;


  // Track if user has started today's report this session
  const [reportStarted,setReportStarted]=useState(false);
  // Build display filename using stored AI convention — swap tokens for actual values
  const buildReportName=(num,reportDate)=>{
    const conv=job.field_config?.filenameConvention||{};
    const padding=conv.numberPadding||0;
    const padNum=padding>0?String(num).padStart(padding,"0"):String(num);
    const pattern=conv.pattern||job.report_filename_pattern||job.name||"Report";
    let n=pattern.replace(/\.[^.]+$/,"");
    const hasDateToken=n.includes("{date}")||n.includes("{year}");
    const hasNumToken=n.includes("{report_number}");
    // Swap tokens
    n=n.replace(/\{report_number\}/g,padNum);
    // Parse the date for this report
    const d=reportDate instanceof Date?reportDate:new Date(typeof reportDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(reportDate)?(reportDate+"T12:00:00"):(reportDate+"T12:00:00"));
    const mm=d.toLocaleDateString("en-US",{month:"2-digit",timeZone:tz});
    const dd=d.toLocaleDateString("en-US",{day:"2-digit",timeZone:tz});
    const yyyy=d.toLocaleDateString("en-US",{year:"numeric",timeZone:tz});
    const monthNames=["January","February","March","April","May","June","July","August","September","October","November","December"];
    const monNames=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const monthIdx=d.toLocaleDateString("en-US",{month:"numeric",timeZone:tz})-1;
    const formatDate=(fmt)=>{
      if(!fmt)return"";
      if(/MM|DD|YYYY|Month|Mon/.test(fmt)){
        return fmt.replace(/YYYY/g,yyyy).replace(/MM/g,mm).replace(/DD/g,dd).replace(/Month/g,monthNames[monthIdx]||"").replace(/Mon/g,monNames[monthIdx]||"");
      }
      // fmt is a literal date from template — detect format and generate this report's date in same format
      const f=fmt.trim();
      if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(f))return d.toLocaleDateString("en-US",{timeZone:tz});
      if(/^\d{4}-\d{2}-\d{2}$/.test(f))return d.toLocaleDateString("en-CA",{timeZone:tz});
      if(/^[A-Za-z]{3}\s+\d{1,2},?\s+\d{4}$/.test(f))return d.toLocaleDateString("en-US",{month:"short",day:"2-digit",year:"numeric",timeZone:tz});
      if(/^[A-Za-z]+\s+\d{1,2},?\s+\d{4}$/.test(f))return d.toLocaleDateString("en-US",{month:"long",day:"2-digit",year:"numeric",timeZone:tz});
      if(/^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(f)){const pd=f.startsWith("0");return d.toLocaleDateString("en-US",{day:pd?"2-digit":"numeric",month:"long",year:"numeric",timeZone:tz}).replace(/^(\w+)\s(\d+),\s(\d+)$/,(_,m,dv,y)=>`${pd?dv.padStart(2,"0"):dv} ${m} ${y}`);}
      if(/^[A-Za-z]{3}\s+\d{1,2}$/.test(f))return monNames[monthIdx]+" "+dd.replace(/^0/,"");
      if(/^\d{2}-\d{2}-\d{4}$/.test(f))return mm+"-"+dd+"-"+yyyy;
      return d.toLocaleDateString("en-US",{timeZone:tz});
    };
    const dateStr=formatDate(conv.dateFormat);
    n=n.replace(/\{date\}/g,dateStr);
    n=n.replace(/\{year\}/g,yyyy);
    n=n.replace(/\{project\}/g,(job.name||"").replace(/\s+/g,"_"));
    // Force-append date/number if pattern had no tokens (raw filename)
    const fmtDay=String(parseInt(dd));
    if(!hasDateToken){
      // Check if pattern contains a literal date (from original template filename) and replace it
      const litDateRx=/(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s_]+\d{1,2}[,\s_]+\d{4}/;
      const newDateStr=monNames[monthIdx]+" "+fmtDay+"_"+yyyy;
      if(litDateRx.test(n)){n=n.replace(litDateRx,newDateStr);}
      else{n+="_"+newDateStr;}
    }
    if(!hasNumToken){
      const replaced=n.replace(/_(\d+)(?=_)/,()=>"_"+padNum);
      if(replaced===n)n=padNum+"_"+n;
      else n=replaced;
    }
    return n;
  };

  const doDelete=async()=>{
    setDeleting(true);
    try{
      await db.deleteJob(job.id);
      showToast("Job deleted");
      onDeleted();
    }catch(e){
      console.error("Delete job failed:",e);
      showToast("Delete failed — try again");
      setDeleting(false);
    }
  };

  const saveJobEdit=async()=>{
    setEditSaving(true);
    try{
      const body={name:editName.trim(),site_address:editAddr.trim()||null};
      await api.rest.patchJob(job.id,body);
      job.name=body.name;job.site_address=body.site_address;
      showToast("Job updated!");
      setShowEditJob(false);
    }catch(e){showToast("Save failed — try again");}
    finally{setEditSaving(false);}
  };

  const [editDate,setEditDate]=useState(null);
  const openReport=(date)=>{setEditDate(date||null);setReportStarted(true);setShowReport(true);};
  const closeReport=()=>{setShowReport(false);setEditDate(null);setLoading(true);loadReports();};

  const fs={width:"100%",padding:"12px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15};
  const ls={display:"block",color:C.lt,fontSize:13,fontWeight:600,marginBottom:6};

  // Collapsible folder
  const Folder=({icon,label,count,color,open,setOpen,children})=>(
    <div style={{marginBottom:12}}>
      <button onClick={()=>setOpen(!open)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"16px 18px",background:C.card,border:`1px solid ${C.brd}`,borderRadius:open?"12px 12px 0 0":12,cursor:"pointer",textAlign:"left"}}>
        <span style={{fontSize:20}}>{icon}</span>
        <span style={{flex:1,fontWeight:700,fontSize:15,color:color||C.txt}}>{label}</span>
        <span style={{fontSize:13,fontWeight:600,color:C.mut,background:C.inp,borderRadius:10,padding:"2px 10px",marginRight:8}}>{count}</span>
        <span style={{color:C.mut,fontSize:14,transform:open?"rotate(180deg)":"none",transition:"transform 0.2s"}}>▼</span>
      </button>
      {open&&<div style={{background:C.card,border:`1px solid ${C.brd}`,borderTop:"none",borderRadius:"0 0 12px 12px",padding:"4px 16px 12px"}}>{children}</div>}
    </div>
  );

  // Visual field editor (full-screen, from job settings)
  if(showVisualFieldEditor&&visualEditorB64){
    const existingFields=fieldEditFields||[];
    return <TemplateFieldEditor pdfBase64={visualEditorB64} initialFields={existingFields}
      onDone={async(placedFields)=>{
        // Convert placed fields back to field_config format and save
        const coords=(f)=>({page:f.page,x:f.x,y:f.y,w:f.w,h:f.h,fontSize:f.fontSize,multiline:f.multiline||f.fieldType==="textarea"});
        const editF=placedFields.filter(f=>f.mode==="edit"||f.mode==="auto-date"||f.mode==="auto-num").map(f=>({name:f.name,value:f.value||"",originalValue:f.value||"",voiceEnabled:f.voiceEnabled!==false,autoFill:f.mode==="auto-date"?"date":f.mode==="auto-num"?"increment":null,...coords(f)}));
        const lockF=placedFields.filter(f=>f.mode==="lock").map(f=>({name:f.name,value:f.value||"",...coords(f)}));
        const conv=job.field_config?.filenameConvention||{};
        const newConfig={editable:editF,locked:lockF,filenameConvention:conv};
        try{
          await db.updateJobFieldConfig(job.id,newConfig);
          job.field_config=newConfig;
          showToast("Fields saved! "+placedFields.length+" field"+(placedFields.length!==1?"s":"")+" configured.");
        }catch(e){showToast("Save failed: "+e.message);}
        setShowVisualFieldEditor(false);setVisualEditorB64(null);setFieldEditFields(null);
      }}
      onCancel={()=>{setShowVisualFieldEditor(false);setVisualEditorB64(null);setFieldEditFields(null);}}/>;
  }

  if(showReport){
    if(job.job_type==="worklog")return<WorkLogEditor key={job.id+"-"+(editDate||"")} job={job} user={user} onBack={closeReport} reportDate={editDate}/>;
    return<ReportEditor key={job.id+"-"+(editDate||"")} job={job} user={user} onBack={closeReport} reportDate={editDate}/>;
  }

  if(loading)return(<div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}><p style={{color:C.mut}}>Loading...</p></div>);

  return(
    <div className="page-in" style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      {jdToast&&<div style={{position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",background:C.card,border:`1px solid ${C.ok}`,borderRadius:10,padding:"10px 20px",fontSize:14,fontWeight:600,color:C.ok,zIndex:9999}}>{jdToast}</div>}
      {/* Header */}
      <div style={{borderBottom:`1px solid ${C.brd}`,background:C.card,padding:"14px 16px"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,maxWidth:600,margin:"0 auto"}}>
        <button onClick={onBack} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:700,fontSize:17,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{job.name}</div>
          {job.site_address&&<div style={{fontSize:12,color:C.mut,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{job.site_address}</div>}
        </div>
        <button onClick={()=>setShowJobSet(!showJobSet)} style={{width:56,height:56,borderRadius:12,background:C.inp,border:`1px solid ${showJobSet?C.org:C.brd}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:28,fontWeight:700,color:"#fff"}}aria-label="Job settings">⚙</button>
      </div>
      </div>

      <div style={{maxWidth:600,margin:"0 auto",padding:"20px"}}>

        {/* ── Today's Report ── */}
        <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:20,marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:22}}>📝</span>
              <div>
                <div style={{fontWeight:700,fontSize:16,color:C.txt}}>Today's Report</div>
                <div style={{fontSize:12,color:C.mut}}>{new Date().toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric",timeZone:tz})}</div>
              </div>
            </div>
            {todayRpt&&(
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{width:10,height:10,borderRadius:"50%",background:todayRpt.status==="submitted"?C.blu:C.org}}/>
                <span style={{fontSize:12,fontWeight:700,color:todayRpt.status==="submitted"?C.blu:C.org}}>{todayRpt.status==="submitted"?"Submitted":"In Progress"}</span>
              </div>
            )}
          </div>
          <button onClick={()=>openReport(today)} className="btn-o" style={{width:"100%",padding:"14px 0",background:C.org,border:"none",borderRadius:10,color:"#fff",fontSize:16,fontWeight:700,cursor:"pointer"}}>
            {todayRpt?(todayRpt.status==="submitted"?"Edit Submitted Report":"Continue Editing"):reportStarted?"Continue Editing":"Start Today's Report"}
          </button>
        </div>

        {/* ── Photo Gallery ── */}
        <Folder icon="📷" label="Photos" count={0} color={C.blu} open={showPhotos} setOpen={setShowPhotos}>
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:36,marginBottom:8}}>📷</div>
            <p style={{fontSize:14,fontWeight:600,color:C.lt,marginBottom:4}}>Job Photo Gallery</p>
            <p style={{fontSize:12,color:C.mut,marginBottom:14}}>Store photos for this job to use in future reports</p>
            <button onClick={()=>showToast("Photo gallery coming soon!")} className="btn-o" style={{padding:"10px 24px",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:600,cursor:"pointer"}}>Take or Upload Photo</button>
          </div>
        </Folder>

        {/* ── Working Copies Folder ── */}
        <Folder icon="📋" label="Working Copies" count={working.length} color={C.org} open={showWorking} setOpen={setShowWorking}>
          {working.length===0?(
            <div style={{textAlign:"center",padding:"16px 0",color:C.mut,fontSize:13}}>No drafts — tap "Start Today's Report" above</div>
          ):(
            working.map((r,i)=>{const rptName=buildReportName(r.report_number||1,r.report_date);return(
              <div key={r.id} style={{display:"flex",alignItems:"center",borderBottom:i<working.length-1?`1px solid ${C.brd}`:"none"}}>
                <button onClick={()=>openReport(r.report_date)} style={{flex:1,minWidth:0,display:"flex",alignItems:"center",gap:12,padding:"14px 16px",background:"transparent",border:"none",cursor:"pointer",textAlign:"left"}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:C.org,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:600,color:C.lt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{rptName}</div>
                    <div style={{fontSize:12,color:C.mut,marginTop:2}}>{new Date(r.report_date+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",timeZone:tz})} — Last edited {r.updated_at?new Date(r.updated_at).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:tz}):""}</div>
                  </div>
                  <div style={{color:C.org,fontSize:20,flexShrink:0}}>›</div>
                </button>
                <button onClick={async(e)=>{e.stopPropagation();if(!await askConfirm("Delete this draft and start over?"))return;const btn=e.currentTarget;btn.disabled=true;btn.style.opacity="0.4";try{await db.deleteReport(r.id,job.id,r.report_date);showToast("Draft deleted");loadReports();}catch(err){showToast("Delete failed");btn.disabled=false;btn.style.opacity="1";}}} style={{padding:"10px 14px",background:"none",border:"none",color:C.err,fontSize:16,cursor:"pointer",flexShrink:0}} title="Delete draft">🗑</button>
              </div>);})

          )}
        </Folder>

        {/* ── Completed Reports Folder ── */}
        <Folder icon="✅" label="Completed Reports" count={submitted.length} color={C.ok} open={showCompleted} setOpen={setShowCompleted}>
          {submitted.length===0?(
            <div style={{textAlign:"center",padding:"16px 0",color:C.mut,fontSize:13}}>No submitted reports yet — completed reports appear here</div>
          ):(
            submitted.map((r,i)=>{
              const rptName=buildReportName(r.report_number||i+1,r.report_date);
              return(
              <button key={r.id} onClick={()=>openReport(r.report_date)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"14px 16px",marginBottom:i<submitted.length-1?0:0,borderBottom:i<submitted.length-1?`1px solid ${C.brd}`:"none",background:"transparent",border:"none",borderBottomWidth:i<submitted.length-1?1:0,borderBottomStyle:"solid",borderBottomColor:C.brd,cursor:"pointer",textAlign:"left"}}>
                <div style={{width:10,height:10,borderRadius:"50%",background:C.ok,flexShrink:0}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:600,color:C.lt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{rptName}</div>
                  <div style={{fontSize:12,color:C.mut,marginTop:2}}>{new Date(r.report_date+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",timeZone:tz})} — Submitted {r.updated_at?new Date(r.updated_at).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZone:tz}):""}</div>
                </div>
                <div style={{color:C.blu,fontSize:20,flexShrink:0}}>›</div>
              </button>
            );})
          )}
        </Folder>

        {/* ── Edit Job (inline) ── */}
        {showEditJob&&(
          <div style={{background:C.card,border:`1px solid ${C.org}`,borderRadius:12,padding:20,marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:15,color:C.org,marginBottom:16,display:"flex",alignItems:"center",gap:8}}>
              <span>✏️</span> Edit Job
            </div>
            <div style={{marginBottom:16}}><label style={ls}>Job Name *</label><input type="text" value={editName} onChange={e=>setEditName(e.target.value)} style={fs}/></div>
            <div style={{marginBottom:16}}><label style={ls}>Site Address</label><input type="text" value={editAddr} onChange={e=>setEditAddr(e.target.value)} style={fs}/></div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setShowEditJob(false)} style={{flex:1,padding:"12px 0",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,fontSize:14,fontWeight:600,cursor:"pointer"}}>Cancel</button>
              <button onClick={saveJobEdit} disabled={editSaving||!editName.trim()} className="btn-o" style={{flex:1,padding:"12px 0",background:editName.trim()?C.org:C.brd,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:editName.trim()&&!editSaving?"pointer":"default",opacity:editSaving?0.6:1}}>
                {editSaving?"Saving...":"Save Changes"}
              </button>
            </div>
          </div>
        )}

        {/* ── Project Team (inline) ── */}
        {showTeam&&(
          <div style={{background:C.card,border:`1px solid ${C.blu}`,borderRadius:12,padding:20,marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <div style={{fontWeight:700,fontSize:15,color:C.blu,display:"flex",alignItems:"center",gap:8}}>
                Project Team
              </div>
              <button onClick={()=>setShowTeam(false)} style={{background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:20,padding:"0 4px"}}>✕</button>
            </div>
            <div style={{fontSize:12,color:C.mut,marginBottom:16,lineHeight:1.5}}>These people will receive an email with the report attached when you tap Submit Report.</div>
            {teamMembers.map((m,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:i<teamMembers.length-1?`1px solid ${C.brd}`:"none"}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:600,color:C.lt}}>{m.name||"No name"}</div>
                  <div style={{fontSize:12,color:C.mut,wordBreak:"break-all"}}>{m.email}</div>
                </div>
                <button onClick={()=>{setTeamMembers(p=>p.filter((_,j)=>j!==i));}} style={{background:"none",border:"none",color:C.err,cursor:"pointer",fontSize:16,padding:"0 4px"}}>✕</button>
              </div>
            ))}
            <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:8}}>
              <input type="text" value={newMemberName} onChange={e=>setNewMemberName(e.target.value)} placeholder="Name" style={{padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:14}}/>
              <div style={{display:"flex",gap:8}}>
                <input type="email" value={newMemberEmail} onChange={e=>setNewMemberEmail(e.target.value)} placeholder="Email" onKeyDown={e=>{if(e.key==="Enter"&&newMemberEmail.trim()&&newMemberEmail.includes("@")){const em=newMemberEmail.trim().toLowerCase();if(teamMembers.some(m=>m.email.toLowerCase()===em)){showToast("That email is already on the team");return;}setTeamMembers(p=>[...p,{name:newMemberName.trim(),email:newMemberEmail.trim()}]);setNewMemberName("");setNewMemberEmail("");}}} style={{flex:1,padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:14}}/>
                <button onClick={()=>{if(newMemberEmail.trim()&&newMemberEmail.includes("@")){const em=newMemberEmail.trim().toLowerCase();if(teamMembers.some(m=>m.email.toLowerCase()===em)){showToast("That email is already on the team");return;}setTeamMembers(p=>[...p,{name:newMemberName.trim(),email:newMemberEmail.trim()}]);setNewMemberName("");setNewMemberEmail("");}}} style={{padding:"10px 16px",background:C.blu,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>Add</button>
              </div>
            </div>
            <div style={{marginTop:16}}>
              <button onClick={async()=>{setTeamSaving(true);try{await api.rest.patchJob(job.id,{team_emails:teamMembers});job.team_emails=teamMembers;setShowTeam(false);}catch(e){showToast("Save failed — try again");}finally{setTeamSaving(false);}}} disabled={teamSaving} className="btn-o" style={{width:"100%",padding:"12px 0",background:C.blu,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:teamSaving?"default":"pointer",opacity:teamSaving?0.6:1}}>
                {teamSaving?"Saving...":"Save Team"}
              </button>
            </div>
          </div>
        )}

        {/* ── TYR v3: Contractors (inline) ── */}
        {isTYR&&showContractors&&(
          <div style={{background:C.card,border:`1px solid ${C.org}`,borderRadius:12,padding:20,marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <div style={{fontWeight:700,fontSize:15,color:C.org,display:"flex",alignItems:"center",gap:8}}>
                Contractors
              </div>
              <button onClick={()=>setShowContractors(false)} style={{background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:20,padding:"0 4px"}}>✕</button>
            </div>
            <div style={{fontSize:12,color:C.mut,marginBottom:16,lineHeight:1.5}}>Manage contractors for this job. Select which ones are on site each day when filling out your report.</div>
            {jobContractors.map((c,i)=>(
              <div key={c.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:i<jobContractors.length-1?`1px solid ${C.brd}`:"none"}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:600,color:C.lt}}>{c.company_name}</div>
                  {c.trade&&<div style={{fontSize:12,color:C.mut}}>{c.trade}</div>}
                </div>
                <button onClick={async()=>{try{await db.removeJobContractor(c.id);setJobContractors(p=>p.filter(x=>x.id!==c.id));showToast("Contractor removed");}catch(e){showToast("Remove failed");}}} style={{background:"none",border:"none",color:C.err,cursor:"pointer",fontSize:16,padding:"0 4px"}}>✕</button>
              </div>
            ))}
            <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:8}}>
              <input type="text" value={newContractorName} onChange={e=>setNewContractorName(e.target.value)} placeholder="Company Name" style={{padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:14}}/>
              <div style={{display:"flex",gap:8}}>
                <input type="text" value={newContractorTrade} onChange={e=>setNewContractorTrade(e.target.value)} placeholder="Trade (optional)" onKeyDown={e=>{if(e.key==="Enter"&&newContractorName.trim()){(async()=>{try{const nc=await db.addJobContractor(job.id,user.id,newContractorName.trim(),newContractorTrade.trim());setJobContractors(p=>[...p,nc]);setNewContractorName("");setNewContractorTrade("");showToast("Contractor added");}catch(er){showToast("Add failed — name may already exist");}})();}}} style={{flex:1,padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:14}}/>
                <button onClick={async()=>{if(!newContractorName.trim())return;try{const nc=await db.addJobContractor(job.id,user.id,newContractorName.trim(),newContractorTrade.trim());setJobContractors(p=>[...p,nc]);setNewContractorName("");setNewContractorTrade("");showToast("Contractor added");}catch(er){showToast("Add failed — name may already exist");}}} style={{padding:"10px 16px",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>Add</button>
              </div>
            </div>
          </div>
        )}

        {showGeneralStmt&&isTYR&&(
          <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",borderBottom:`1px solid ${C.brd}`}}>
              <div style={{fontWeight:700,fontSize:15,color:C.org}}>General Statement</div>
              <button onClick={()=>setShowGeneralStmt(false)} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,cursor:"pointer",fontSize:13,fontWeight:600,padding:"6px 14px"}}>Close</button>
            </div>
            <div style={{padding:"14px 18px"}}>
              <div style={{fontSize:12,color:C.mut,marginBottom:10}}>This statement auto-fills on every new TYR daily report. Edit it here to update for all future reports.</div>
              <textarea value={generalStmt} onChange={e=>setGeneralStmt(e.target.value)} placeholder="Enter general statement for this project..." rows={6} style={{width:"100%",boxSizing:"border-box",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,padding:"14px 16px",fontSize:14,color:C.lt,resize:"vertical",minHeight:120,lineHeight:1.6,fontFamily:"inherit"}}/>
              <button onClick={async()=>{setGeneralStmtSaving(true);try{await db.updateJobGeneralStatement(job.id,generalStmt);job.general_statement=generalStmt;showToast("General statement saved!");}catch(e){showToast("Save failed");}finally{setGeneralStmtSaving(false);}}} disabled={generalStmtSaving} style={{marginTop:10,width:"100%",padding:"12px 0",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:generalStmtSaving?"default":"pointer",opacity:generalStmtSaving?0.6:1}}>
                {generalStmtSaving?"Saving...":"Save General Statement"}
              </button>
            </div>
          </div>
        )}

        {/* ── Scheduling Contacts (inline) ── */}
        {showSchedContacts&&(
          <div style={{background:C.card,border:`1px solid ${C.org}`,borderRadius:12,padding:20,marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <div style={{fontWeight:700,fontSize:15,color:C.org,display:"flex",alignItems:"center",gap:8}}>
                Scheduling Contacts
              </div>
              <button onClick={()=>setShowSchedContacts(false)} style={{background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:20,padding:"0 4px"}}>✕</button>
            </div>
            <div style={{fontSize:12,color:C.mut,marginBottom:16,lineHeight:1.5}}>People who appear on the scheduling request form. Separate from your Project Team (report recipients).</div>
            {schedContacts.map((m,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:i<schedContacts.length-1?`1px solid ${C.brd}`:"none"}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:600,color:C.lt}}>{m.name||"No name"}</div>
                  <div style={{fontSize:12,color:C.mut,wordBreak:"break-all"}}>{m.email}</div>
                </div>
                <button onClick={()=>{setSchedContacts(p=>p.filter((_,j)=>j!==i));}} style={{background:"none",border:"none",color:C.err,cursor:"pointer",fontSize:16,padding:"0 4px"}}>✕</button>
              </div>
            ))}
            <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:8}}>
              <input type="text" value={newSchedName} onChange={e=>setNewSchedName(e.target.value)} placeholder="Name" style={{padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:14}}/>
              <div style={{display:"flex",gap:8}}>
                <input type="email" value={newSchedEmail} onChange={e=>setNewSchedEmail(e.target.value)} placeholder="Email" onKeyDown={e=>{if(e.key==="Enter"&&newSchedEmail.trim()&&newSchedEmail.includes("@")){const em=newSchedEmail.trim().toLowerCase();if(schedContacts.some(m=>m.email.toLowerCase()===em)){showToast("That email is already added");return;}setSchedContacts(p=>[...p,{name:newSchedName.trim(),email:newSchedEmail.trim()}]);setNewSchedName("");setNewSchedEmail("");}}} style={{flex:1,padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:14}}/>
                <button onClick={()=>{if(newSchedEmail.trim()&&newSchedEmail.includes("@")){const em=newSchedEmail.trim().toLowerCase();if(schedContacts.some(m=>m.email.toLowerCase()===em)){showToast("That email is already added");return;}setSchedContacts(p=>[...p,{name:newSchedName.trim(),email:newSchedEmail.trim()}]);setNewSchedName("");setNewSchedEmail("");}}} style={{padding:"10px 16px",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>Add</button>
              </div>
            </div>
            <div style={{marginTop:16}}>
              <button onClick={async()=>{setSchedContactsSaving(true);try{await api.rest.patchJob(job.id,{scheduling_contacts:schedContacts});job.scheduling_contacts=schedContacts;setShowSchedContacts(false);showToast("Scheduling contacts saved!");}catch(e){showToast("Save failed — try again");}finally{setSchedContactsSaving(false);}}} disabled={schedContactsSaving} style={{width:"100%",padding:"12px 0",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:schedContactsSaving?"default":"pointer",opacity:schedContactsSaving?0.6:1}}>
                {schedContactsSaving?"Saving...":"Save Scheduling Contacts"}
              </button>
            </div>
          </div>
        )}

        {/* ── Scheduling Settings (inline) ── */}
        {showSchedSet&&(
          <div style={{background:C.card,border:`1px solid ${C.org}`,borderRadius:12,padding:20,marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <div style={{fontWeight:700,fontSize:15,color:C.org,display:"flex",alignItems:"center",gap:8}}>
                <span>📅</span> Jobsite Scheduling
              </div>
              <button onClick={()=>setShowSchedSet(false)} style={{background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:20,padding:"0 4px"}}>✕</button>
            </div>
            <div style={{fontSize:12,color:C.mut,marginBottom:16,lineHeight:1.5}}>When enabled, this job appears on your shared scheduling calendar so your GC and subs can request site visits.</div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,marginBottom:16}}>
              <span style={{fontSize:14,fontWeight:600,color:C.lt}}>Enable Scheduling</span>
              <button onClick={()=>setSchedEnabled(!schedEnabled)} style={{width:48,height:26,borderRadius:13,border:"none",background:schedEnabled?C.ok:C.brd,cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
                <div style={{width:20,height:20,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:schedEnabled?25:3,transition:"left 0.2s"}}/>
              </button>
            </div>
            {schedEnabled&&(
              <div>
                <div style={{fontSize:12,color:C.ok,lineHeight:1.5,marginBottom:12}}>This job will appear on your shared calendar. Anyone with your calendar link can request visits for this job.</div>
                <div style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,padding:12,marginBottom:12}}>
                  <div style={{fontSize:12,fontWeight:700,color:C.blu,marginBottom:6}}>Your Calendar Link</div>
                  <div style={{fontSize:11,color:C.org,wordBreak:"break-all",marginBottom:8,fontWeight:600}}>{`${window.location.origin}${window.location.pathname.replace(/index\.html$/,"").replace(/\/$/,"")}/hub.html?i=${jdSlug||user?.user_metadata?.full_name?.toLowerCase().replace(/\s+/g,"-")||"inspector"}`}</div>
                  <button onClick={async()=>{const s=jdSlug||user?.user_metadata?.full_name?.toLowerCase().replace(/\s+/g,"-")||"inspector";const url=`${window.location.origin}${window.location.pathname.replace(/index\.html$/,"").replace(/\/$/,"")}/hub.html?i=${s}`;try{await navigator.clipboard.writeText(url);showToast("Calendar link copied!");}catch(e){showToast("Couldn't copy — long-press the link above");}}} style={{width:"100%",padding:"8px 0",fontSize:12,fontWeight:700,borderRadius:6,background:C.blu,border:"none",color:"#fff",cursor:"pointer",marginBottom:4}}>Copy Calendar Link</button>
                  <button onClick={()=>{const s=jdSlug||user?.user_metadata?.full_name?.toLowerCase().replace(/\s+/g,"-")||"inspector";window.open(`${window.location.origin}${window.location.pathname.replace(/index\.html$/,"").replace(/\/$/,"")}/hub.html?i=${s}&admin=true`,"_blank");}} style={{width:"100%",padding:"8px 0",fontSize:12,fontWeight:700,borderRadius:6,background:"transparent",border:`1px solid ${C.brd}`,color:C.lt,cursor:"pointer",marginBottom:10}}>Open My Calendar (Admin)</button>
                  <details style={{borderTop:`1px solid ${C.brd}`,paddingTop:8}}>
                    <summary style={{fontSize:12,color:C.blu,fontWeight:600,cursor:"pointer",listStyle:"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>Subscribe to Your Own Calendar<span style={{fontSize:14}}>+</span></summary>
                    <div style={{paddingTop:8,fontSize:12,color:C.lt,lineHeight:1.6}}>
                      <div style={{marginBottom:8}}><strong style={{color:C.txt}}>iPhone:</strong> Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar → paste the URL above</div>
                      <div style={{marginBottom:8}}><strong style={{color:C.txt}}>Android / Google:</strong> Open Google Calendar on desktop → click + next to "Other calendars" → From URL → paste the URL above</div>
                      <div style={{marginBottom:8}}><strong style={{color:C.txt}}>Outlook Desktop:</strong> Calendar view → Add Calendar → From Internet → paste the URL above</div>
                      <div><strong style={{color:C.txt}}>Outlook Mobile:</strong> Calendar → Settings → Add Shared Calendar → Add from link → paste the URL above</div>
                    </div>
                  </details>
                </div>
              </div>
            )}
            <button onClick={async()=>{setSchedSaving(true);try{await api.rest.patchJob(job.id,{scheduling_enabled:schedEnabled});job.scheduling_enabled=schedEnabled;setShowSchedSet(false);}catch(e){showToast("Save failed — try again");}finally{setSchedSaving(false);}}} disabled={schedSaving} style={{width:"100%",padding:"12px 0",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:schedSaving?"default":"pointer",opacity:schedSaving?0.6:1}}>
              {schedSaving?"Saving...":"Save Scheduling"}
            </button>
          </div>
        )}

        {/* ── Frequency & Reminders Panel ── */}
        {showFreqSet&&(
          <div id="freq-reminders-panel" role="region" aria-labelledby="freq-reminders-heading" style={{background:C.card,border:`1px solid ${C.org}`,borderRadius:12,padding:20,marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <h3 id="freq-reminders-heading" style={{fontWeight:700,fontSize:15,color:C.org,display:"flex",alignItems:"center",gap:8,margin:0}}>
                <span>🔔</span> Frequency & Reminders
              </h3>
              <button type="button" aria-label="Close Frequency & Reminders" onClick={()=>setShowFreqSet(false)} style={{background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:20,padding:"0 4px"}}>✕</button>
            </div>
            <div style={{fontSize:12,color:C.mut,marginBottom:16,lineHeight:1.5}}>Set how often you file reports and when to get reminded.</div>
            <div style={{fontSize:13,fontWeight:600,color:C.lt,marginBottom:8}} id="report-days-label">Report Days</div>
            <div role="group" aria-labelledby="report-days-label" style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
              {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=>{const a=jdDays.includes(d);return<button type="button" key={d} aria-pressed={a} onClick={()=>jdTogDay(d)} style={{width:42,height:42,borderRadius:"50%",border:a?`2px solid ${C.org}`:`1px solid #555`,background:a?C.org:"transparent",color:a?"#fff":C.mut,fontWeight:600,fontSize:11,cursor:"pointer"}}>{d}</button>;})}
            </div>
            <div role="radiogroup" aria-label="Report frequency" style={{display:"flex",gap:8,marginBottom:16}}>
              {[{k:"weekly",l:"Weekly"},{k:"as_needed",l:"As Needed"}].map(({k,l})=><button type="button" role="radio" aria-checked={jdSched===k} key={k} onClick={()=>jdPreset(k)} style={{padding:"8px 14px",borderRadius:8,border:jdSched===k?`2px solid ${C.org}`:`1px solid #555`,background:jdSched===k?C.org:"transparent",color:jdSched===k?"#fff":C.mut,fontWeight:600,fontSize:12,cursor:"pointer"}}>{l}</button>)}
            </div>
            {jdEffSch()!=="as_needed"&&(
              <div style={{marginBottom:16}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,marginBottom:10}}>
                  <span style={{fontSize:14,fontWeight:600,color:C.lt}}>Report Reminders</span>
                  <button onClick={()=>setJdRemOn(!jdRemOn)} style={{width:48,height:26,borderRadius:13,border:"none",background:jdRemOn?C.ok:C.brd,cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
                    <div style={{width:20,height:20,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:jdRemOn?25:3,transition:"left 0.2s"}}/>
                  </button>
                </div>
                {jdRemOn&&(
                  <div style={{display:"flex",gap:10}}>
                    <div style={{flex:1}}><label style={{display:"block",color:C.mut,fontSize:11,marginBottom:4}}>Submit by</label><select value={jdRemT} onChange={e=>setJdRemT(e.target.value)} style={{width:"100%",padding:"8px 10px",background:C.bg,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:13}}>
                      {["12:00 PM","1:00 PM","2:00 PM","3:00 PM","4:00 PM","5:00 PM","6:00 PM","7:00 PM","8:00 PM","9:00 PM"].map(t=><option key={t} value={t}>{t}</option>)}
                    </select></div>
                    <div style={{flex:1}}><label style={{display:"block",color:C.mut,fontSize:11,marginBottom:4}}>Remind me</label><select value={jdRemH} onChange={e=>setJdRemH(Number(e.target.value))} style={{width:"100%",padding:"8px 10px",background:C.bg,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:13}}>
                      {[1,2,3,4,6].map(h=><option key={h} value={h}>{h} hr{h>1?"s":""} before</option>)}
                    </select></div>
                  </div>
                )}
              </div>
            )}
            <button onClick={async()=>{setFreqSaving(true);try{const es=jdEffSch();const patch={schedule:es,schedule_days:es==="custom"?jdDays:[],reminder_enabled:jdRemOn,reminder_time:jdRemOn?jdRemT:null,reminder_hours_before:jdRemOn?jdRemH:null};await api.rest.patchJob(job.id,patch);Object.assign(job,patch);setShowFreqSet(false);showToast("Frequency & reminders saved");}catch(e){showToast("Save failed — try again");}finally{setFreqSaving(false);}}} disabled={freqSaving} style={{width:"100%",padding:"12px 0",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:freqSaving?"default":"pointer",opacity:freqSaving?0.6:1}}>
              {freqSaving?"Saving...":"Save Frequency & Reminders"}
            </button>
          </div>
        )}

        {/* ── Edit Template Fields Panel ── */}
        {showFieldEdit&&fieldEditFields&&(
          <div style={{background:C.card,border:`1px solid ${C.org}`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 16px",borderBottom:`1px solid ${C.brd}`,background:"rgba(232,116,42,0.06)"}}>
              <div style={{fontWeight:700,fontSize:15,color:C.org}}>Edit Template Fields</div>
              <button onClick={()=>{setShowFieldEdit(false);setFieldEditFields(null);}} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,cursor:"pointer",fontSize:13,fontWeight:600,padding:"6px 14px"}}>Done</button>
            </div>
            <div style={{padding:16}}>
            <div style={{fontSize:11,color:C.mut,marginBottom:12,lineHeight:1.5}}>Change field modes and values. This affects all future reports for this job.</div>
            <div style={{marginBottom:12}}>
              {fieldEditFields.map((f,i)=>{
                const setMode=(m)=>setFieldEditFields(p=>p.map((x,j)=>j===i?{...x,mode:m}:x));
                const setVal=(v)=>setFieldEditFields(p=>p.map((x,j)=>j===i?{...x,value:v}:x));
                const mb=(mode,label,color)=>{const active=f.mode===mode;return(<button key={mode} onClick={()=>setMode(mode)} style={{padding:"3px 8px",fontSize:10,fontWeight:700,borderRadius:4,cursor:"pointer",background:active?color:"transparent",border:`1px solid ${active?color:C.brd}`,color:active?"#fff":color}}>{label}</button>);};
                return(
                  <div key={f.name} style={{padding:"10px 12px",background:C.bg,border:`1px solid ${C.brd}`,borderRadius:8,marginBottom:6}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                      <span style={{fontSize:13,fontWeight:700,color:C.txt,flex:1,marginRight:8}}>{f.name}</span>
                      <div style={{display:"flex",gap:4,flexShrink:0}}>
                        {mb("edit","Edit",C.org)}
                        {mb("lock","Lock",C.mut)}
                        {mb("auto-date","Auto-Date",C.blu)}
                        {mb("auto-num","Auto-#",C.blu)}
                      </div>
                    </div>
                    {f.mode!=="auto-date"&&f.mode!=="auto-num"&&(
                      <input type="text" value={f.value||""} onChange={e=>setVal(e.target.value)} placeholder={f.mode==="lock"?"Set locked value...":"Default value (optional)"} style={{width:"100%",padding:"8px 10px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:6,color:C.txt,fontSize:13,boxSizing:"border-box"}}/>
                    )}
                    {f.mode==="auto-date"&&<div style={{fontSize:11,color:C.blu,fontStyle:"italic",padding:"4px 0"}}>Auto-fills today's date</div>}
                    {f.mode==="auto-num"&&<div style={{fontSize:11,color:C.blu,fontStyle:"italic",padding:"4px 0"}}>Auto-increments each report</div>}
                  </div>
                );
              })}
            </div>
            <button onClick={async()=>{
              setFieldEditSaving(true);
              try{
                const coords=(f)=>({page:f.page,x:f.x,y:f.y,w:f.w,h:f.h,fontSize:f.fontSize,multiline:f.multiline});
                const editF=fieldEditFields.filter(f=>f.mode==="edit").map(f=>({name:f.name,value:f.value||"",originalValue:f.value||"",voiceEnabled:true,...coords(f)}));
                const lockF=fieldEditFields.filter(f=>f.mode==="lock").map(f=>({name:f.name,value:f.value||"",...coords(f)}));
                const autoF=fieldEditFields.filter(f=>f.mode==="auto-date"||f.mode==="auto-num").map(f=>({name:f.name,value:f.value||"",originalValue:f.value||"",autoFill:f.mode==="auto-date"?"date":"increment",...coords(f)}));
                const newConfig={editable:[...editF,...autoF],locked:lockF};
                await db.updateJobFieldConfig(job.id,newConfig);
                job.field_config=newConfig;
                setShowFieldEdit(false);
                setFieldEditFields(null);
              }catch(e){showToast("Save failed — try again");}
              finally{setFieldEditSaving(false);}
            }} disabled={fieldEditSaving} style={{width:"100%",padding:"12px 0",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:fieldEditSaving?"default":"pointer",opacity:fieldEditSaving?0.6:1}}>
              {fieldEditSaving?"Saving...":"Save Field Changes"}
            </button>
          </div>
          </div>
        )}

        {/* ── Job Settings Panel ── */}
        {showJobSet&&(
          <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",borderBottom:`1px solid ${C.brd}`,background:"rgba(232,116,42,0.06)"}}>
              <div style={{fontWeight:700,fontSize:15,color:C.org}}>Job Settings</div>
              <button onClick={()=>setShowJobSet(false)} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,cursor:"pointer",fontSize:13,fontWeight:600,padding:"6px 14px"}}>Done</button>
            </div>
            <button onClick={()=>{setShowEditJob(!showEditJob);setEditName(job.name);setEditAddr(job.site_address||"");}} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              <span style={{fontSize:16}}>✏️</span><span style={{fontSize:14,fontWeight:600,color:C.lt}}>Edit Job Details</span>
            </button>
            {/* Job Logo */}
            <div style={{padding:"14px 18px",borderBottom:`1px solid ${C.brd}`}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                <span style={{fontSize:14,fontWeight:600,color:C.lt}}>Report Logo</span>
                {jobLogoUploading&&<span style={{fontSize:11,color:C.mut}}>Uploading...</span>}
              </div>
              {jobLogoUrl?(
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <img src={jobLogoUrl+(jobLogoUrl.includes("?")?`&cb=${Date.now()}`:`?cb=${Date.now()}`)} style={{width:56,height:56,objectFit:"contain",borderRadius:8,border:`1px solid ${C.brd}`,background:"#fff"}} alt="Logo"/>
                  <button onClick={()=>jobLogoInputRef.current?.click()} disabled={jobLogoUploading} style={{padding:"6px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:6,color:C.lt,fontSize:12,cursor:"pointer"}}>Change</button>
                  <button onClick={async()=>{setJobLogoUploading(true);try{await db.removeJobLogo(job.id);job.logo_url=null;setJobLogoUrl(null);showToast("Logo removed");}catch(e){showToast("Remove failed");}finally{setJobLogoUploading(false);}}} disabled={jobLogoUploading} style={{padding:"6px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:6,color:C.err,fontSize:12,cursor:"pointer"}}>Remove</button>
                </div>
              ):(
                <div>
                  <button onClick={()=>jobLogoInputRef.current?.click()} disabled={jobLogoUploading} style={{padding:"10px 16px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,fontSize:13,cursor:"pointer"}}>Upload Logo</button>
                  <div style={{fontSize:11,color:C.mut,marginTop:4}}>Uses your company logo if not set.</div>
                </div>
              )}
              <input ref={jobLogoInputRef} type="file" accept="image/*" style={{display:"none"}} onChange={async(e)=>{
                const f=e.target.files?.[0];if(!f)return;
                if(f.size>2*1024*1024){showToast("Logo must be under 2MB");return;}
                if(!f.type.startsWith("image/")){showToast("Must be an image");return;}
                setJobLogoUploading(true);
                try{const url=await db.uploadJobLogo(job.id,f);job.logo_url=url;setJobLogoUrl(url);showToast("Logo updated!");}
                catch(err){showToast("Upload failed: "+err.message);}
                finally{setJobLogoUploading(false);if(jobLogoInputRef.current)jobLogoInputRef.current.value="";}
              }}/>
            </div>
            <button type="button" aria-expanded={showTeam} onClick={()=>setShowTeam(!showTeam)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:14,fontWeight:600,color:C.lt}}>Project Team</span>
              </div>
              <span style={{fontSize:11,color:C.mut,background:C.inp,borderRadius:10,padding:"2px 8px"}}>{teamMembers.length}</span>
            </button>
            <button onClick={()=>setShowSchedContacts(!showSchedContacts)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:14,fontWeight:600,color:C.lt}}>Scheduling Contacts</span>
              </div>
              <span style={{fontSize:11,color:C.mut,background:C.inp,borderRadius:10,padding:"2px 8px"}}>{schedContacts.length}</span>
            </button>
            {isTYR&&(
              <button type="button" aria-expanded={showContractors} onClick={()=>setShowContractors(!showContractors)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:16}}>🏗️</span><span style={{fontSize:14,fontWeight:600,color:C.lt}}>Contractors</span>
                </div>
                <span style={{fontSize:11,color:C.mut,background:C.inp,borderRadius:10,padding:"2px 8px"}}>{jobContractors.length}</span>
              </button>
            )}
            {isTYR&&(
              <button type="button" aria-expanded={showGeneralStmt} onClick={()=>setShowGeneralStmt(!showGeneralStmt)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:16}}>📋</span><span style={{fontSize:14,fontWeight:600,color:C.lt}}>General Statement</span>
                </div>
                <span style={{fontSize:11,color:generalStmt?C.ok:C.mut,fontWeight:600}}>{generalStmt?"Set":"Not Set"}</span>
              </button>
            )}
            <button onClick={()=>{if(!fieldEditFields){const fc=job.field_config||{};const all=[...(fc.editable||[]).map(f=>({...f,mode:f.autoFill==="date"?"auto-date":f.autoFill==="increment"?"auto-num":"edit"})),...(fc.locked||[]).map(f=>({...f,mode:"lock"}))];setFieldEditFields(all);}setShowFieldEdit(!showFieldEdit);}} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              <span style={{fontSize:14,fontWeight:600,color:C.lt}}>Edit Template Fields</span>
            </button>
            <button onClick={()=>reuploadRef.current?.click()} disabled={reuploading} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:16}}>📄</span><span style={{fontSize:14,fontWeight:600,color:C.lt}}>{reuploading?"Uploading...":"Replace Template File"}</span>
              </div>
              {tplFilename&&<span style={{fontSize:11,color:C.mut,maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tplFilename}</span>}
            </button>
            <input ref={reuploadRef} type="file" accept=".pdf,.docx,.doc,.jpg,.jpeg,.png" onChange={handleReuploadTemplate} style={{display:"none"}}/>
            {job.field_config&&(
              <button onClick={async()=>{const cur=!!job.weather_enabled;try{await db.updateJobWeatherEnabled(job.id,!cur);job.weather_enabled=!cur;showToast("Weather "+(job.weather_enabled?"enabled":"disabled"));}catch(e){showToast("Save failed");}}} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:16}}>🌤️</span><span style={{fontSize:14,fontWeight:600,color:C.lt}}>Weather on Report</span>
                </div>
                <span style={{fontSize:11,color:job.weather_enabled?C.ok:C.mut,fontWeight:600}}>{job.weather_enabled?"ON":"OFF"}</span>
              </button>
            )}
            <button onClick={async()=>{const cur=!!job.field_config?.aiPhotos;const fc={...(job.field_config||{}),aiPhotos:!cur};try{await db.updateJobFieldConfig(job.id,fc);job.field_config=fc;showToast("AI Photo Descriptions "+(fc.aiPhotos?"enabled":"disabled"));}catch(e){showToast("Save failed");}}} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:16}}>🤖</span><span style={{fontSize:14,fontWeight:600,color:C.lt}}>AI Photo Descriptions</span>
              </div>
              <span style={{fontSize:11,color:job.field_config?.aiPhotos?C.ok:C.mut,fontWeight:600}}>{job.field_config?.aiPhotos?"ON":"OFF"}</span>
            </button>
            <button onClick={async()=>{const cur=!!job.field_config?.aiProofread;const fc={...(job.field_config||{}),aiProofread:!cur};try{await db.updateJobFieldConfig(job.id,fc);job.field_config=fc;showToast("AI Proofreading "+(fc.aiProofread?"enabled":"disabled"));}catch(e){showToast("Save failed");}}} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:16}}>✍️</span><span style={{fontSize:14,fontWeight:600,color:C.lt}}>AI Proofreading</span>
              </div>
              <span style={{fontSize:11,color:job.field_config?.aiProofread?C.ok:C.mut,fontWeight:600}}>{job.field_config?.aiProofread?"ON":"OFF"}</span>
            </button>
            <button type="button" aria-expanded={showSchedSet} onClick={()=>{setShowSchedSet(!showSchedSet);setShowTeam(false);}} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:16}}>📅</span><span style={{fontSize:14,fontWeight:600,color:C.lt}}>Jobsite Scheduling</span>
              </div>
              <span style={{fontSize:11,color:schedEnabled?C.ok:C.mut,fontWeight:600}}>{schedEnabled?"ON":"OFF"}</span>
            </button>
            <button type="button" aria-expanded={showFreqSet} aria-controls="freq-reminders-panel" onClick={()=>{setShowFreqSet(!showFreqSet);}} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:16}}>🔔</span><span style={{fontSize:14,fontWeight:600,color:C.lt}}>Frequency & Reminders</span>
              </div>
              <span style={{fontSize:11,color:C.mut,fontWeight:600}}>{SL[job.schedule]||job.schedule||"As Needed"}</span>
            </button>
            <button onClick={async()=>{const isArch=job.is_archived===true||job.is_archived==='true'||job.is_archived==='t';const newVal=!isArch;console.log("[Archive] toggling",{jobId:job.id,rawVal:job.is_archived,typeofVal:typeof job.is_archived,isArch,newVal,jobName:job.name});try{const result=await api.rest.patchJob(job.id,{is_archived:newVal});console.log("[Archive] success",result);showToast(newVal?"Job archived":"Job restored");if(onBack)onBack();}catch(e){console.error("[Archive] FAILED:",e);showToast("Archive failed: "+e.message);}}} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"14px 18px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:16}}>📦</span><span style={{fontSize:14,fontWeight:600,color:C.lt}}>{(job.is_archived===true||job.is_archived==='true'||job.is_archived==='t')?"Restore from Archive":"Archive This Job"}</span>
              </div>
            </button>
            <div style={{padding:"14px 18px",borderTop:`1px solid #5c2023`}}>
              {!showDel?(
                <button onClick={()=>setShowDel(true)} style={{width:"100%",padding:"10px 16px",background:"transparent",border:"1px solid #5c2023",borderRadius:8,color:C.err,fontSize:13,fontWeight:600,cursor:"pointer"}}>Delete This Job</button>
              ):(
                <div>
                  <p style={{fontSize:12,color:C.err,lineHeight:1.5,marginBottom:10}}>Permanently delete "{job.name}" and all its reports, templates, and data. Cannot be undone.</p>
                  <div style={{display:"flex",gap:10}}>
                    <button onClick={()=>setShowDel(false)} style={{flex:1,padding:"10px 0",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,fontSize:13,fontWeight:600,cursor:"pointer"}}>Cancel</button>
                    <button onClick={doDelete} disabled={deleting} style={{flex:1,padding:"10px 0",background:"#ef4444",border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:deleting?"default":"pointer",opacity:deleting?0.6:1}}>
                      {deleting?"Deleting...":"Delete Permanently"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Training Center ── */
const GUIDES=[
  {icon:"→",color:C.blu,title:"Getting Started",sub:"Set up your account and create your first job",steps:[
    {icon:"✓",title:"Sign In",body:"Enter your email and password or create a new account. Your data syncs across all devices.",tip:"Name and email can't be changed after sign up — double-check before submitting."},
    {icon:"▬",title:"The Dashboard",body:"Your home screen. Active jobs show status dots: red = due, orange = in progress, green = submitted. Tap any job to open it.",tip:null},
    {icon:"+",title:"Create a Job",body:"Tap \"+ New Job\", enter a job name and site address, then choose your report type: Template (upload a PDF) or Work Log (track contractors and hours). If your company has templates, they'll appear automatically.",tip:null},
    {icon:"—",title:"Company Templates",body:"If your company has set up a template, just type the company name during job creation. The template loads automatically — fields, naming convention, and all.",tip:"Company templates save time. Everyone on the team gets the same format without re-uploading."},
    {icon:"▼",title:"Switch Jobs",body:"Use the Jobs dropdown at the top to switch between active jobs.",tip:null},
  ]},
  {icon:"—",color:C.ok,title:"Template Reports",sub:"Fill in a PDF template with daily entries",steps:[
    {icon:"▶",title:"Start a Report",body:"From the job dashboard, tap \"Start Today's Report\". Locked fields are pre-filled. Auto-date shows today. Auto-# increments from your last report.",tip:"One report per day per job. Working copies can be edited anytime."},
    {icon:"✏",title:"Fill In Fields",body:"Editable fields are ready for your daily entries — notes, weather, hours, observations. Locked fields (project name, contractor, etc.) are already filled in.",tip:null},
    {icon:"🎤",title:"Voice Dictation",body:"Tap any text field, then tap the mic on your keyboard. Speak naturally — your phone's built-in dictation does the rest. No extra setup needed.",tip:"Take notes throughout the day as things happen. Come back later and everything's saved.",
      illustration:{type:"form",rows:[
        {label:'Say "period"',value:".",good:true,note:"Inserts a period at the end of your sentence"},
        {label:'Say "comma"',value:",",good:true,note:"Inserts a comma"},
        {label:'Say "new line"',value:"↵",good:true,note:"Starts a new line — each line becomes a bullet point in your report"},
        {label:'Say "new paragraph"',value:"↵↵",good:true,note:"Adds a blank line between sections"},
      ]}},
    {icon:"💡",title:"Voice Dictation Tips",body:"Your phone's dictation understands punctuation commands. Say them naturally as you talk and they'll appear as punctuation, not words. Each new line in Notes becomes a bullet point on the PDF.",tip:"Say \"new line\" between items to get clean bullet points. Example: \"Poured footings for grid A new line Set rebar for grid B new line Backfill east side complete\"",
      illustration:{type:"form",rows:[
        {label:'Say "question mark"',value:"?",good:true,note:"Inserts a question mark"},
        {label:'Say "exclamation point"',value:"!",good:true,note:"Inserts an exclamation point"},
        {label:'Say "colon"',value:":",good:true,note:"Inserts a colon"},
        {label:'Say "dash"',value:"—",good:true,note:"Inserts a dash"},
      ]}},
    {icon:"📷",title:"Photos & AI",body:"Add photos to your report with the Photo or Library buttons. If AI Descriptions is enabled in Job Settings, tap the orange AI button on any photo to auto-generate a description that goes straight into your notes field.",tip:"AI descriptions are limited to 25 per job per day. Great for quick documentation of site conditions."},
    {icon:"—",title:"Save & Submit",body:"Tap \"Save Working Copy\" to save progress. Tap \"Submit\" when done — the app generates a PDF using your template with your entries overlaid and emails it to your team. Need a fresh start? Delete the working copy from the submit screen.",tip:null},
    {icon:"🖥",title:"Desktop Editing",body:"On a desktop or laptop, tap \"View Report\" to see your PDF with editable fields overlaid directly on the template. Click any field to type right on the document — what you see is what gets submitted. Changes sync back to the form automatically.",tip:"Great for office users who prefer editing on a full-size screen. Fields are highlighted with orange borders so you can see exactly where your entries go."},
  ]},
  {icon:"▬",color:C.org,title:"Work Log Reports",sub:"Track contractors, hours, and daily activity",steps:[
    {icon:"+",title:"Add Contractors",body:"Tap \"+ Add Contractor\" and enter their name. Add a work description, hours, and quantity (number of people). Use your keyboard mic to dictate descriptions.",tip:null},
    {icon:"🔒",title:"Save Contractors",body:"Expand a contractor and choose \"Name + Work\" or \"Name Only\" under Carry Over to keep them on tomorrow's report. Hours and photos always reset.",tip:"Use \"Name + Work\" for crews doing the same task every day. Use \"Name Only\" when the work changes daily."},
    {icon:"📷",title:"Photos",body:"Each contractor has Photo and Library buttons at the bottom of their card. Take a photo with your camera or pick from your library. Photos are grouped by contractor in the report. If AI Descriptions is enabled in Job Settings, tap the orange AI button on any photo to auto-generate a description.",tip:"AI descriptions are limited to 25 per job per day. Context shots, close-ups of issues, and progress photos make the best documentation."},
    {icon:"—",title:"Custom Sections",body:"Need to track something extra? Tap \"+ Add Category\" to create new sections like Materials or Equipment. In the Survey, tap \"+ Add Concern\" to add custom questions.",tip:null},
    {icon:"✓",title:"Preview & Submit",body:"Tap \"View Report\" to preview the PDF. Weather, work logs, notes, survey — it's all there. Hit \"Submit Report\" to generate and email the final PDF. On desktop, template fields are editable directly on the preview.",tip:null},
  ]},
  {icon:"→",color:"#a855f7",title:"Exporting & Sharing",sub:"Generate PDFs and email reports",steps:[
    {icon:"—",title:"PDF Generation",body:"The submit button generates a professional PDF with your daily entries. Template reports overlay your data onto the original PDF. Work logs build a clean report from scratch.",tip:"Report numbers are sequential: #1, #2, #3 — based on submissions, not calendar days."},
    {icon:"—",title:"Email Reports",body:"Email the PDF to your project team on submit. Set up default recipients in your job's Project Team settings.",tip:null},
    {icon:"↻",title:"Past Reports",body:"Completed reports live in the Completed folder on your job dashboard. Re-download or resend anytime.",tip:null},
  ]},
  {icon:"⚙",color:"#14b8a6",title:"Managing Jobs",sub:"Edit, update, and organize your projects",steps:[
    {icon:"⚙",title:"Job Settings",body:"Tap the gear icon on any job dashboard. From here: edit job name and address, manage your project team (name + email), edit template fields, toggle scheduling, enable AI photo descriptions, or delete the job.",tip:"AI Descriptions adds an orange AI button to every photo — tap it to auto-generate a description from the image."},
    {icon:"—",title:"Edit Template Fields",body:"In Job Settings, tap \"Edit Template Fields\" to change any field's mode (Edit, Lock, Auto-Date, Auto-#) or update its value. Changes apply to all future reports.",tip:null},
    {icon:"↻",title:"Replace Template",body:"Need to swap in a new PDF? In Job Settings, tap \"Replace Template File\" to upload a fresh version. Your field configuration is preserved — only the underlying PDF changes.",tip:"Useful when your company updates their form or you uploaded the wrong file."},
    {icon:"▬",title:"Archive a Job",body:"When a project is done, archive it. Reports and data are preserved but the job hides from your active list.",tip:"Archive instead of delete — you may need old reports later."},
  ]},
  {icon:"📅",color:C.blu,title:"Scheduling Calendar",sub:"Share your availability with your team",steps:[
    {icon:"📅",title:"Your Calendar",body:"Enable Jobsite Scheduling on any job (in Job Settings) and it appears on your shared calendar. One link covers all your scheduling-enabled jobs.",tip:null},
    {icon:"🔗",title:"Share Your Link",body:"Tap \"Share Calendar\" on the dashboard. Send the link to your team, subs, or anyone who needs to coordinate site visits.",tip:"Set your Scheduling Display Name in Account Settings so people recognize your calendar."},
    {icon:"—",title:"Requests",body:"Visitors pick a job and date from your calendar link. You see the request and can approve or reschedule it.",tip:null},
  ]},
  {icon:"—",color:"#f59e0b",title:"Preparing Your Template",sub:"How to upload your PDF for the best results",steps:[
    {icon:"—",title:"We Copy Your PDF",body:"Upload your report as a PDF and we make a working copy. Fillable PDFs with form fields work best — we read the field names directly. For flat PDFs, our AI scans the layout to detect fields.",tip:"Fillable PDFs give the most accurate field detection.",
      illustration:{type:"form",rows:[
        {label:"Date:",value:"",good:true,note:"Leave blank — Auto-Date fills this"},
        {label:"Project Name:",value:"Woodland Park MS",good:true,note:"Pre-filled values become locked fields"},
        {label:"DR #:",value:"",good:true,note:"Leave blank — Auto-# fills this"},
      ]}},
    {icon:"✗",title:"Clean Out Old Values",body:"Clear any old dates, report numbers, or sample text before uploading. The app fills these in fresh each day, but leftover text can show through underneath.",tip:null,
      illustration:{type:"compare",bad:{label:"Date:",value:"04 February 2026",caption:"Old date bleeds through"},good:{label:"Date:",value:"",caption:"Clean — auto-date fills it fresh"}}},
    {icon:"—",title:"Notes Section",body:"Label your notes area clearly (\"Notes:\" or \"Observations:\") and leave it blank. Daily entries fill into the same spot on your template every time.",tip:null,
      illustration:{type:"form",rows:[
        {label:"Standing Note:",value:"Available for daily communication...",good:true,note:"Lock this — stays the same every report"},
        {label:"Notes:",value:"",good:true,note:"Blank — your daily notes go here"},
      ]}},
    {icon:"✓",title:"Best Practices & Help",body:"Single-page PDF, standard letter size (8.5\" x 11\"). Fillable PDFs with form fields give the best results. If detection doesn't look right, try uploading again or email your template to support@mydailyreports.org and we'll set it up for you.",tip:"One template per job — reused for every report.",
      illustration:{type:"checklist",items:[
        {text:"PDF format (fillable PDFs work best)",ok:true},
        {text:"Single page, letter size",ok:true},
        {text:"Clear out old dates and numbers",ok:true},
        {text:"Signature lines — ignored automatically",ok:true},
        {text:"Need help? Email support@mydailyreports.org",ok:true},
      ]}},
  ]},
  {icon:"⚙",color:C.mut,title:"Settings",sub:"Account, timezone, and preferences",steps:[
    {icon:"—",title:"Account Settings",body:"Tap the gear icon on the dashboard, then \"Account Settings\". View your profile, set timezone, and configure your scheduling display name.",tip:null},
    {icon:"—",title:"Reminders",body:"Email reminders are set per-job during creation. You'll get reminded before your report is due based on your schedule.",tip:null},
    {icon:"—",title:"Sign Out",body:"Account Settings → Sign Out. The app keeps you logged in by default. Your data stays saved when you come back.",tip:null},
  ]},
];


export default JobDetail;
