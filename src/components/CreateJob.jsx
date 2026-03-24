import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { C } from '../constants/theme';
import { db } from '../utils/db';
import { AUTH_TOKEN, refreshAuthToken } from '../utils/auth';
import { api } from '../utils/api';
import { SB_URL, SB_KEY, TYR_COMPANY_ID, ENHANCED_TYR_ID } from '../constants/supabase';
import { askConfirm } from './ConfirmOverlay';
import { extractPdfTextStructure, readAcroFormFields } from '../utils/auth';
import { ensurePdfLib, ensureMammoth } from '../utils/pdf';
import { checkAiLimit, incrementAiUsage } from '../utils/ai-usage';
import TemplateFieldEditor from './TemplateFieldEditor';

function CreateJob({user, onBack, onCreated}){
  const [cjToast,setCjToast]=useState("");
  const showToast=(m)=>{setCjToast(m);setTimeout(()=>setCjToast(""),3000);};
  const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [jn,setJn]=useState("");
  const [addr,setAddr]=useState("");
  const [tf,setTf]=useState(null);
  const [tfB64,setTfB64]=useState(null); // cached base64 string of template file (survives iOS Safari GC)
  const [freqOn,setFreqOn]=useState(false);
  const [sched,setSched]=useState("");
  const [days,setDays]=useState([]);
  const [remOn,setRemOn]=useState(false);
  const [remT,setRemT]=useState("5:00 PM");
  const [remH,setRemH]=useState(2);
  const [schedOn,setSchedOn]=useState(false);
  const [saving,setSaving]=useState(false);
  const [err,setErr]=useState("");
  const [drag,setDrag]=useState(false);
  const [parsing,setParsing]=useState(false);
  const [fields,setFields]=useState([]); // unified field list: {name, value, mode: "edit"|"lock"|"auto-date"|"auto-num"}
  const [savedTpls,setSavedTpls]=useState([]); // user's saved/reusable templates
  const [loadingSaved,setLoadingSaved]=useState(true);
  const [showSaved,setShowSaved]=useState(false);
  const [usedSavedId,setUsedSavedId]=useState(null); // id of saved template being used
  const [reportTitle,setReportTitle]=useState(""); // editable report title (for saved template reuse)
  const [fnConvention,setFnConvention]=useState(null); // AI-detected: {pattern, dateFormat, numberPadding}
  const [savingTpl,setSavingTpl]=useState(false);
  const [tplSaved,setTplSaved]=useState(false); // whether current parse was saved
  const [showFieldEditor,setShowFieldEditor]=useState(false); // click-to-place editor
  const [jobType,setJobType]=useState("template"); // "template" or "worklog"
  // Company autocomplete for job-level company (whose template we use)
  const [jobCompanyName,setJobCompanyName]=useState("");
  const [jobCompanyMatches,setJobCompanyMatches]=useState([]);
  const [jobSelectedCompany,setJobSelectedCompany]=useState(null); // {id,name}
  const [jobCompanyTemplates,setJobCompanyTemplates]=useState([]);
  const [showCompanyTpls,setShowCompanyTpls]=useState(true);
  const jobCompanyDebounce=useRef(null);
  const trackParseAttempt=()=>{};
  // Job-level logo
  const [jobLogoFile,setJobLogoFile]=useState(null);
  const [jobLogoPreview,setJobLogoPreview]=useState(null);
  const jobLogoRef=useRef(null);

  // Load saved templates on mount
  useEffect(()=>{
    db.getSavedTemplates(user.id).then(t=>{setSavedTpls(t);setLoadingSaved(false);}).catch(()=>setLoadingSaved(false));
  },[user.id]);

  // Company name search — debounced lookup as user types
  const handleJobCompanyChange=(val)=>{
    setJobCompanyName(val);
    setJobSelectedCompany(null);
    setJobCompanyTemplates([]);
    if(jobCompanyDebounce.current)clearTimeout(jobCompanyDebounce.current);
    if(val.trim().length<2){setJobCompanyMatches([]);return;}
    jobCompanyDebounce.current=setTimeout(async()=>{
      try{
        const matches=await db.searchCompanies(val.trim());
        setJobCompanyMatches(matches);
      }catch(e){setJobCompanyMatches([]);}
    },400);
  };

  const selectJobCompany=async(company)=>{
    setJobSelectedCompany(company);
    setJobCompanyName(company.name);
    setJobCompanyMatches([]);
    // Fetch company templates and copy to user's saved templates
    try{
      console.log("[CreateJob] fetching templates for company",company.id,company.name);
      const tpls=await db.getCompanyTemplates(company.id);
      console.log("[CreateJob] found",tpls.length,"company templates",tpls.map(t=>({id:t.id,name:t.template_name,path:t.storage_path})));
      setJobCompanyTemplates(tpls);
      if(tpls.length){
        // Copy company templates to user's saved_templates table
        // Note: DB RPC copies to templates table (per-job), but we need saved_templates (reusable)
        // Always use JS fallback which correctly saves to saved_templates
        try{await db.copyCompanyTemplatesToUser(tpls,user.id);console.log("[CreateJob] copyCompanyTemplatesToUser succeeded");}catch(e){console.error("[CreateJob] Template copy failed:",e.message);}
        // Refresh saved templates list so they appear immediately
        try{const updated=await db.getSavedTemplates(user.id);setSavedTpls(updated);}catch(e){}
      }
    }catch(e){console.error("[CreateJob] getCompanyTemplates failed:",e);setJobCompanyTemplates([]);}
  };

  const clearJobCompany=()=>{
    setJobSelectedCompany(null);
    setJobCompanyName("");
    setJobCompanyTemplates([]);
  };

  const DS=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const TS=["12:00 PM","1:00 PM","2:00 PM","3:00 PM","4:00 PM","5:00 PM","6:00 PM","7:00 PM","8:00 PM","9:00 PM"];

  const togDay=(d)=>{setSched("custom");setDays(p=>p.includes(d)?p.filter(x=>x!==d):[...p,d]);};
  const preset=(p)=>{setSched(p);setDays([]);if(p==="as_needed")setRemOn(false);};
  const effSch=()=>{if(!freqOn)return"as_needed";if(sched==="weekly"||sched==="as_needed")return sched;if(days.length===5&&["Mon","Tue","Wed","Thu","Fri"].every(d=>days.includes(d))&&!days.includes("Sat")&&!days.includes("Sun"))return"daily_mf";if(days.length===7)return"daily_7";if(days.length>0)return"custom";return sched||"as_needed";};

  const readFileAsBase64=async(f)=>{return new Promise((res)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.readAsDataURL(f);});};

  const parseFields=async(buf,fileName)=>{
    setParsing(true);setErr("");setFields([]);
    trackParseAttempt(fileName);
    try{
      // Step 0: Try AcroForm fields first (fillable PDFs)
      console.log("[parseFields] Step 0: checking for AcroForm fields...");
      const acroFields=await readAcroFormFields(new Uint8Array(buf));
      if(acroFields&&acroFields.length>0){
        console.log("[parseFields] Found",acroFields.length,"AcroForm fields — using direct field names");
        // Group date segment fields (e.g., "Date Recd", "Date Recd-0", "Date Recd-1" → single date field)
        const dateGroups={};const usedInGroup=new Set();
        acroFields.forEach(f=>{
          const m=f.pdfFieldName.match(/^(.+)-(\d+)$/);
          if(m){
            const base=m[1];const idx=parseInt(m[2]);
            if(!dateGroups[base])dateGroups[base]={base,parts:[]};
            dateGroups[base].parts.push({idx,pdfFieldName:f.pdfFieldName});
            usedInGroup.add(f.pdfFieldName);
          }
        });
        // Also check if the base name exists as its own field (the "0" part)
        acroFields.forEach(f=>{
          if(dateGroups[f.pdfFieldName]&&!usedInGroup.has(f.pdfFieldName)){
            dateGroups[f.pdfFieldName].parts.push({idx:-1,pdfFieldName:f.pdfFieldName});
            usedInGroup.add(f.pdfFieldName);
          }
        });
        const all=[];const seenNames=new Set();
        acroFields.forEach(f=>{
          if(usedInGroup.has(f.pdfFieldName)){
            // If this is the base name (no suffix), create a grouped date field
            const group=dateGroups[f.pdfFieldName];
            if(group&&!seenNames.has(f.pdfFieldName.toLowerCase())){
              seenNames.add(f.pdfFieldName.toLowerCase());
              const parts=[f.pdfFieldName,...group.parts.sort((a,b)=>a.idx-b.idx).map(p=>p.pdfFieldName)];
              const uniqueParts=[...new Set(parts)];
              let mode="edit";
              if(f.autoFill==="date")mode="auto-date";
              else if(f.autoFill)mode="lock";
              all.push({name:f.displayName,pdfFieldName:f.pdfFieldName,pdfDateParts:uniqueParts,value:f.value||"",mode,type:f.type,autoFill:f.autoFill||"date",multiline:false,voiceEnabled:false,source:"acroform",fontSize:f.fontSize||null});
            }
            return; // skip individual parts
          }
          const key=f.pdfFieldName.toLowerCase().trim();
          if(seenNames.has(key))return;
          seenNames.add(key);
          let mode="edit";
          if(f.category==="signature")mode="signature";
          else if(f.autoFill==="date")mode="auto-date";
          else if(f.autoFill==="ir_number")mode="auto-num";
          else if(f.autoFill)mode="lock"; // auto-filled fields start locked
          all.push({name:f.displayName,pdfFieldName:f.pdfFieldName,value:f.value||"",mode,type:f.type,autoFill:f.autoFill,multiline:f.multiline,voiceEnabled:f.multiline,source:"acroform",fontSize:f.fontSize||null});
        });
        setFields(all);
        return; // skip AI detection
      }
      // Step 1: Extract real text positions client-side with pdf.js (flat PDF fallback)
      console.log("[parseFields] No AcroForm fields — falling back to text extraction + AI...");
      const textItems=await extractPdfTextStructure(new Uint8Array(buf));
      console.log("[parseFields] Extracted",textItems.length,"text items");
      if(!textItems||textItems.length===0){
        setErr("This PDF has no extractable text (it may be a scanned image). You can still create the job and add fields manually.");
        return;
      }
      // Step 2: Send text items (not base64 PDF) to edge function for semantic mapping
      const payload={text_items:textItems,file_name:fileName};
      console.log("[parseFields] Step 2: calling edge function, payload size:",JSON.stringify(payload).length);
      const parsed=await api.parseTemplate({text_items:textItems,file_name:fileName});
      console.log("[parseFields] Edge function responded with keys:",Object.keys(parsed));
      if(parsed.error)throw new Error(parsed.error);
      // Merge editable + locked into one unified list (preserve coords for PDF fill)
      const all=[];const seenNames=new Set();
      const NOTES_KW=["notes","observations","comments"];
      const isNotesField=(n)=>NOTES_KW.some(k=>(n||"").toLowerCase().includes(k));
      let notesAdded=false;
      const addUnique=(f,mode)=>{
        const key=(f.name||"").toLowerCase().trim();
        if(seenNames.has(key))return;
        // Only allow ONE notes-like field (first one wins)
        if(isNotesField(f.name)){if(notesAdded)return;notesAdded=true;}
        seenNames.add(key);
        all.push({name:f.name,value:f.value||"",mode,page:f.page,x:f.x,y:f.y,w:f.w,h:f.h,fontSize:f.fontSize,multiline:f.multiline,voiceEnabled:f.voiceEnabled});
      };
      (parsed.editable||[]).forEach(f=>{
        let mode="edit";
        if(f.autoFill==="date")mode="auto-date";
        else if(f.autoFill==="increment")mode="auto-num";
        addUnique(f,mode);
      });
      (parsed.locked||[]).forEach(f=>{addUnique(f,"lock");});
      setFields(all);
      // Store AI-detected filename convention (dateFormat, numberPadding) for auto-numbering
      if(parsed.filenameConvention){
        setFnConvention(parsed.filenameConvention);
        // Use AI pattern with {date}/{report_number} tokens as the display title
        if(parsed.filenameConvention.pattern)setReportTitle(parsed.filenameConvention.pattern);
      }
    }catch(e){
      console.error("Parse error:",e);
      setErr("Could not parse template fields: "+(e.message||e)+". You can still create the job and configure fields later.");
    }finally{setParsing(false);}
  };

  // Parse DOCX template — sends raw file to edge function for XML extraction + AI analysis
  const parseDocxFields=async(buf,fileName)=>{
    setParsing(true);setErr("");setFields([]);
    trackParseAttempt(fileName);
    try{
      // Convert ArrayBuffer to base64
      const bytes=new Uint8Array(buf);
      let binary="";for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
      const b64=btoa(binary);
      const parsed=await api.parseTemplate({docx_base64:b64,file_name:fileName});
      if(parsed.error)throw new Error(parsed.error);
      // Same merge logic as PDF path
      const all=[];const seenNames=new Set();
      const NOTES_KW=["notes","observations","comments"];
      const isNotesField=(n)=>NOTES_KW.some(k=>(n||"").toLowerCase().includes(k));
      let notesAdded=false;
      const addUnique=(f,mode)=>{
        const key=(f.name||"").toLowerCase().trim();
        if(seenNames.has(key))return;
        if(isNotesField(f.name)){if(notesAdded)return;notesAdded=true;}
        seenNames.add(key);
        all.push({name:f.name,value:f.value||"",mode,page:f.page,x:f.x,y:f.y,w:f.w,h:f.h,fontSize:f.fontSize,multiline:f.multiline,voiceEnabled:f.voiceEnabled});
      };
      (parsed.editable||[]).forEach(f=>{
        let mode="edit";
        if(f.autoFill==="date")mode="auto-date";
        else if(f.autoFill==="increment")mode="auto-num";
        addUnique(f,mode);
      });
      (parsed.locked||[]).forEach(f=>{addUnique(f,"lock");});
      setFields(all);
      if(parsed.filenameConvention){
        setFnConvention(parsed.filenameConvention);
        if(parsed.filenameConvention.pattern)setReportTitle(parsed.filenameConvention.pattern);
      }
    }catch(e){
      console.error("DOCX parse error:",e);
      setErr("Could not parse DOCX fields: "+e.message);
    }finally{setParsing(false);}
  };

  const ALLOWED_EXTS=["pdf","docx","doc","jpg","jpeg","png"];
  const doFile=async(f)=>{
    const e=f.name.split(".").pop().toLowerCase();
    if(!ALLOWED_EXTS.includes(e)){setErr("Accepted formats: PDF, DOCX, JPG, PNG");return;}
    setTf(f);setErr("");setUsedSavedId(null);setReportTitle(f.name.replace(/\.[^.]+$/,""));setFnConvention(null);setTplSaved(false);
    try{
      const buf=await f.arrayBuffer();
      // Store as base64 string — immune to iOS Safari releasing the file buffer
      const u8=new Uint8Array(buf);const chunks=[];for(let i=0;i<u8.length;i+=8192)chunks.push(String.fromCharCode.apply(null,u8.subarray(i,i+8192)));
      setTfB64(btoa(chunks.join("")));
      // Auto-detect fields via Edge Function
      if(e==="pdf"){
        parseFields(buf.slice(0),f.name);
      }else if(e==="docx"||e==="doc"){
        parseDocxFields(buf.slice(0),f.name);
      }else{
        setFields([]);setParsing(false);
      }
    }catch(bufErr){console.error("File buffer read:",bufErr);setErr("Could not read file. Try again.");}
  };

  // Use a saved template — loads fields without re-parsing, but still needs the actual file uploaded
  // Job-specific locked fields become editable so user can enter new values for the new job
  const JOB_SPECIFIC_FIELDS=["project name","project no","project number","owner","client","district","dsa file","dsa file #","dsa app","dsa app #","contractor","architect","engineer","inspector","ior","project inspector","project manager","address","location","jurisdiction"];
  const [loadingTpl,setLoadingTpl]=useState(false);
  const [loadingTplId,setLoadingTplId]=useState(null); // track which template is loading
  const useSavedTemplate=async(tpl)=>{
    setLoadingTpl(true);setLoadingTplId(tpl.id);setErr("");
    try{
    let raw=tpl.field_config||[];
    // Validate field_config — must be an array; if it's the new {editable,locked} schema, normalize
    if(raw&&!Array.isArray(raw)){
      if(raw.editable||raw.locked){raw=[...(raw.editable||[]).map(f=>({...f,mode:f.mode||"edit"})),...(raw.locked||[]).map(f=>({...f,mode:f.mode||"lock"}))];}
      else{console.warn("Invalid field_config format, resetting");raw=[];}
    }
    // Extract filename convention if embedded (from admin provisioning)
    const convEntry=raw.find(f=>f._type==="filenameConvention");
    const fieldEntries=raw.filter(f=>!f._type);
    if(convEntry){const{_type,...conv}=convEntry;setFnConvention(conv);}
    // Convert job-specific locked fields to editable with cleared values
    const adjusted=fieldEntries.map(f=>{
      if(f.mode==="lock"){
        const nameLC=(f.name||"").toLowerCase().trim();
        const isJobSpecific=JOB_SPECIFIC_FIELDS.some(js=>nameLC===js||nameLC.startsWith(js+" ")||nameLC.endsWith(" "+js)||nameLC.includes(" "+js+" "));
        if(isJobSpecific)return{...f,mode:"edit",value:"",lockAfterCreate:true};
      }
      return{...f};
    });
    if(adjusted.length>0)setFields(adjusted);
    setUsedSavedId(tpl.id);
    // Use stored AI pattern with {date} tokens if available, otherwise raw filename
    const storedPattern=convEntry?.pattern;
    setReportTitle(storedPattern||tpl.original_filename?.replace(/\.[^.]+$/,"")||tpl.name||"");
    setTplSaved(adjusted.length>0);
    setShowSaved(false);
    // Download the template file using central download function
    if(tpl.storage_path){
        if(!AUTH_TOKEN){throw new Error("Authentication required to download template");}
        try{
          const buf=await db.downloadTemplateBytes(tpl.storage_path);
          const blob=new Blob([buf]);
          const ext=tpl.file_type||tpl.original_filename?.split(".").pop().toLowerCase()||"pdf";
          const file=new File([blob],tpl.original_filename||tpl.file_name||`template.${ext}`,{type:ext==="pdf"?"application/pdf":"application/octet-stream"});
          setTf(file);
          const u8=new Uint8Array(buf);
          const chunks=[];for(let i=0;i<u8.length;i+=8192)chunks.push(String.fromCharCode.apply(null,u8.subarray(i,i+8192)));
          setTfB64(btoa(chunks.join("")));
          // If no fields were loaded (company template without field_config), auto-parse the file
          if(adjusted.length===0){
            if(ext==="pdf")await parseFields(buf,file.name);
            else if(ext==="docx"||ext==="doc")await parseDocxFields(buf,file.name);
          }
        }catch(dlErr){
          console.error("[useSavedTemplate] Download failed:",dlErr);
          setErr("Could not load template file. Try uploading the file manually.");
        }
    }else if(adjusted.length===0){
      setErr("This template doesn't have a file yet. Upload a PDF to get started.");
    }
    }catch(dlErr){console.error("[useSavedTemplate] Error:",dlErr);setErr("Template loading failed: "+dlErr.message);}
    finally{setLoadingTpl(false);setLoadingTplId(null);}
  };

  // When file is uploaded after selecting a saved template, skip parsing
  const doFileWithSaved=async(f)=>{
    const e=f.name.split(".").pop().toLowerCase();
    if(!ALLOWED_EXTS.includes(e)){setErr("Accepted formats: PDF, DOCX, JPG, PNG");return;}
    setTf(f);setErr("");
    try{const buf=await f.arrayBuffer();const u8=new Uint8Array(buf);const chunks=[];for(let i=0;i<u8.length;i+=8192)chunks.push(String.fromCharCode.apply(null,u8.subarray(i,i+8192)));setTfB64(btoa(chunks.join("")));}catch(bufErr){console.error("File buffer read:",bufErr);setErr("Could not read file. Try again.");}
    // Fields already loaded from saved template — no parsing needed
  };

  // Save current parsed fields as a reusable template
  const saveAsTemplate=async()=>{
    if(!fields.length||!tf||savingTpl)return;
    setSavingTpl(true);
    try{
      await db.saveParsedTemplate({
        user_id:user.id,
        name:tf.name.replace(/\.[^.]+$/,""),
        original_filename:tf.name,
        file_type:tf.name.split(".").pop().toLowerCase(),
        field_config:fields,
        storage_path:null // file stays with the job, this just saves the field mapping
      });
      setTplSaved(true);
      // Refresh the list
      const updated=await db.getSavedTemplates(user.id);
      setSavedTpls(updated);
    }catch(e){setErr("Could not save template: "+e.message);}
    finally{setSavingTpl(false);}
  };

  // Field management
  const setFieldMode=(name,mode)=>{setFields(p=>p.map(f=>f.name===name?{...f,mode}:f));};
  const setFieldValue=(name,val)=>{setFields(p=>p.map(f=>f.name===name?{...f,value:val}:f));};

  // Mode button style helper
  const modeBtn=(fieldName,mode,label,color)=>{
    const active=fields.find(f=>f.name===fieldName)?.mode===mode;
    return(
      <button onClick={()=>setFieldMode(fieldName,mode)} style={{
        padding:"6px 10px",fontSize:11,fontWeight:700,borderRadius:6,cursor:"pointer",minHeight:32,
        background:active?color:"transparent",
        border:`1px solid ${active?color:C.brd}`,
        color:active?"#fff":(color===C.brd?C.mut:color),
        whiteSpace:"nowrap"
      }}>{label}</button>
    );
  };

  const ok=jn.trim();

  const create=async()=>{
    if(!ok){setErr("Job name is required.");return;}setSaving(true);setErr("");
    try{
      const es=effSch();
      // Use edited report title as the pattern — user can tweak what AI detected
      const filePattern=reportTitle.trim()||(tf?tf.name.replace(/\.[^.]+$/,""):"");
      // Store the AI-detected convention (dateFormat, numberPadding) alongside the pattern
      const convention=fnConvention?{pattern:filePattern,dateFormat:fnConvention.dateFormat||"",numberPadding:fnConvention.numberPadding||0}:{pattern:filePattern,dateFormat:"",numberPadding:0};
      const isAcroForm=fields.some(f=>f.source==="acroform");
      const coords=(f)=>({page:f.page,x:f.x,y:f.y,w:f.w,h:f.h,fontSize:f.fontSize,multiline:f.multiline});
      const acroProps=(f)=>isAcroForm?{pdfFieldName:f.pdfFieldName,type:f.type,autoFill:f.autoFill}:{};
      // Fields marked lockAfterCreate (from saved template reuse) go back to locked with the user's new values
      const editFields=fields.filter(f=>f.mode==="edit"&&!f.lockAfterCreate).map(f=>({name:f.name,value:"",originalValue:f.value||"",voiceEnabled:true,...coords(f),...acroProps(f)}));
      const lockFields=[...fields.filter(f=>f.mode==="lock"),...fields.filter(f=>f.mode==="edit"&&f.lockAfterCreate)].map(f=>({name:f.name,value:f.value,...coords(f),...acroProps(f)}));
      const autoFields=fields.filter(f=>f.mode==="auto-date"||f.mode==="auto-num").map(f=>({name:f.name,value:f.value,originalValue:f.value||"",autoFill:f.mode==="auto-date"?"date":"increment",...coords(f),...acroProps(f)}));
      const sigFields=isAcroForm?fields.filter(f=>f.mode==="signature").map(f=>({name:f.name,value:"",pdfFieldName:f.pdfFieldName,type:"signature"})):[];
      const fc={editable:[...editFields,...autoFields],locked:lockFields,signatures:sigFields,filenameConvention:convention,source:isAcroForm?"acroform":"ai_detected"};
      const job=await db.mkJob({user_id:user.id,name:jn.trim(),site_address:addr.trim()||null,company_id:jobSelectedCompany?.id||null,job_type:jobType,report_filename_pattern:filePattern,schedule:es,schedule_days:es==="custom"?days:[],reminder_enabled:remOn,reminder_time:remOn?remT:null,reminder_hours_before:remOn?remH:null,scheduling_enabled:schedOn,field_config:fc});
      if(tf&&job?.id){
        try{
          const ext=tf.name.split(".").pop().toLowerCase();
          // Convert from base64 string back to Blob for upload
          if(!tfB64)throw new Error("Template file data was lost. Please go back and re-upload the file.");
          const raw=atob(tfB64);const u8=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)u8[i]=raw.charCodeAt(i);
          const fileBuf=u8.buffer;
          const fileBlob=new Blob([u8],{type:tf.type||"application/octet-stream"});
          const sp=await db.ulTpl(user.id,job.id,fileBlob,ext);
          const tplData={user_id:user.id,job_id:job.id,name:tf.name,original_filename:tf.name,file_type:ext,storage_path:sp,field_config:fields.length?fields:[]};
          await db.mkTpl(tplData);
          // Render PDF pages to images for preview cache — fire-and-forget (don't block job creation)
          if(ext==="pdf"){
            (async()=>{try{
              await ensurePdfJs();
              const renderBuf=fileBuf.slice(0);
              const pjDoc=await window.pdfjsLib.getDocument({data:renderBuf}).promise;
              const imgs=[];
              for(let i=1;i<=pjDoc.numPages;i++){
                const pg=await pjDoc.getPage(i);
                const vp=pg.getViewport({scale:1.5});
                const cvs=document.createElement("canvas");cvs.width=vp.width;cvs.height=vp.height;
                await pg.render({canvasContext:cvs.getContext("2d"),viewport:vp}).promise;
                imgs.push(cvs.toDataURL("image/jpeg",0.85));
                cvs.width=0;cvs.height=0;
              }
              const pagePaths=await db.saveTemplatePages(user.id,job.id,imgs);
              if(pagePaths.length>0){
                // Update template record with page images in background
                try{await api.rest.patchTemplateByJob(job.id,{structure_map:{page_images:pagePaths}});}catch(e){}
              }
            }catch(pgErr){console.error("Template page render:",pgErr);}})();
          }
        }catch(tplErr){
          // Template upload failed — clean up the orphan job so no ghost card appears
          try{await db.deleteJob(job.id);}catch(delErr){console.error("Orphan job cleanup failed for job "+job.id+":",delErr);}
          throw new Error("Template upload failed: "+(tplErr.message||"Unknown error")+". Job was not created.");
        }
      }
      // Upload job logo if one was selected
      if(jobLogoFile&&job?.id){
        try{await db.uploadJobLogo(job.id,jobLogoFile);}catch(logoErr){console.error("Job logo upload (non-fatal):",logoErr);}
      }
      onCreated();
    }catch(e){setErr(e.message||"Something went wrong. Please try again.");}finally{setSaving(false);}
  };

  // Toggle box component
  const ToggleBox=({icon,label,desc,on,setOn,children})=>(
    <div style={{marginBottom:12,background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:18}}>{icon}</span>
          <span style={{fontSize:14,fontWeight:600,color:C.lt}}>{label}</span>
        </div>
        <button onClick={()=>setOn(!on)} style={{width:48,height:28,borderRadius:14,border:"none",cursor:"pointer",background:on?C.org:C.brd,position:"relative"}}>
          <div style={{width:22,height:22,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:on?23:3,transition:"left 0.2s"}}/>
        </button>
      </div>
      {on&&<div style={{padding:"0 16px 16px",borderTop:`1px solid ${C.brd}`}}>{desc&&<div style={{fontSize:12,color:C.mut,marginTop:12,marginBottom:12}}>{desc}</div>}{children}</div>}
    </div>
  );

  const fs={width:"100%",padding:"12px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15};
  const ls={display:"block",color:C.lt,fontSize:13,fontWeight:600,marginBottom:6};

  // Click-to-place field editor (full-screen overlay)
  if(showFieldEditor&&tfB64){
    return <TemplateFieldEditor pdfBase64={tfB64} initialFields={fields}
      onDone={(placedFields)=>{setFields(placedFields);setShowFieldEditor(false);}}
      onCancel={()=>setShowFieldEditor(false)}/>;
  }

  return(
    <div className="page-in" style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      {cjToast&&<div style={{position:"fixed",bottom:30,left:"50%",transform:"translateX(-50%)",background:"#333",color:"#fff",padding:"10px 20px",borderRadius:8,fontSize:13,zIndex:99999}}>{cjToast}</div>}
      <div style={{borderBottom:`1px solid ${C.brd}`,background:C.card,padding:"14px 16px"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,maxWidth:600,margin:"0 auto"}}>
        <button onClick={onBack} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <span style={{fontWeight:700,fontSize:17}}>New Job</span>
      </div>
      </div>
      <div style={{maxWidth:500,margin:"0 auto",padding:"24px 20px"}}>
        {err&&<div style={{background:"#2d1214",border:"1px solid #5c2023",borderRadius:8,padding:"10px 14px",marginBottom:16,color:C.err,fontSize:13}}>{err}</div>}

        {/* Job Name — required */}
        <div style={{marginBottom:20}}><label style={ls}>Job Name *</label><input type="text" value={jn} onChange={e=>setJn(e.target.value)} style={fs}/></div>

        {/* Site Address — optional */}
        <div style={{marginBottom:20}}><label style={ls}>Site Address</label><input type="text" value={addr} onChange={e=>setAddr(e.target.value)} style={fs}/></div>

        {/* Company — links to company template library */}
        <div style={{marginBottom:20,position:"relative"}}>
          <label style={ls}>Company</label>
          {jobSelectedCompany?(
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10}}>
              <div style={{flex:1,fontSize:15,fontWeight:600,color:C.txt}}>{jobSelectedCompany.name}</div>
              <button onClick={clearJobCompany} style={{background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:18,padding:"0 4px",lineHeight:1}}>✕</button>
            </div>
          ):(
            <input type="text" value={jobCompanyName} onChange={e=>handleJobCompanyChange(e.target.value)} placeholder="Type to search companies..." style={fs}/>
          )}
          <div style={{fontSize:11,color:C.mut,marginTop:4}}>The company this job belongs to.</div>
          {/* Company match dropdown */}
          {jobCompanyMatches.length>0&&!jobSelectedCompany&&(
            <div style={{position:"absolute",left:0,right:0,zIndex:50,background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,marginTop:4,overflow:"hidden",boxShadow:"0 8px 24px rgba(0,0,0,0.15)"}}>
              {jobCompanyMatches.map(m=>(
                <button key={m.id} onClick={()=>selectJobCompany(m)} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"12px 14px",background:"transparent",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:600,color:C.txt}}>{m.name}</div>
                    <div style={{fontSize:11,color:C.mut}}>Tap to select</div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {/* Collapsible company templates — shows right under company when selected */}
          {jobSelectedCompany&&jobCompanyTemplates.length>0&&jobType==="template"&&!tf&&(
            <div style={{marginTop:8,border:`1px solid ${C.brd}`,borderRadius:10,overflow:"hidden",background:C.card}}>
              <button onClick={()=>setShowCompanyTpls(!showCompanyTpls)} style={{width:"100%",padding:"10px 14px",background:"transparent",border:"none",color:C.lt,fontSize:13,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span>Company Template ({jobCompanyTemplates.length})</span>
                <span style={{fontSize:12,color:C.mut}}>{showCompanyTpls?"▲":"▼"}</span>
              </button>
              {showCompanyTpls&&jobCompanyTemplates.map(t=>{
                const isThis=loadingTplId===t.id;
                const isOther=loadingTpl&&!isThis;
                return(
                <div key={"co-"+t.id} onClick={()=>{if(!loadingTpl)useSavedTemplate({...t,name:t.template_name||t.name||t.file_name});}} style={{padding:"10px 14px",borderTop:`1px solid ${C.brd}`,display:"flex",alignItems:"center",gap:10,cursor:loadingTpl?"default":"pointer",opacity:isOther?0.4:1,background:isThis?"rgba(232,116,42,0.08)":"transparent"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:600,color:C.txt}}>{t.template_name||t.name||t.file_name||"Template"}</div>
                    <div style={{fontSize:11,color:C.mut}}>{t.file_type?t.file_type.toUpperCase():"PDF"}</div>
                  </div>
                  <span style={{color:isThis?C.org:C.blu,fontSize:12,fontWeight:700}}>{isThis?"Loading...":"Use"}</span>
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Job Logo (Optional) — only for work logs */}
        {jobType==="worklog"&&(<div style={{marginBottom:20}}>
          <label style={ls}>Report Logo (Optional)</label>
          <input ref={jobLogoRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>2*1024*1024){setErr("Logo must be under 2MB");return;}if(!f.type.startsWith("image/")){setErr("Logo must be an image");return;}setJobLogoFile(f);const r=new FileReader();r.onload=()=>setJobLogoPreview(r.result);r.readAsDataURL(f);}}/>
          {jobLogoPreview?(
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <img src={jobLogoPreview} style={{width:56,height:56,objectFit:"contain",borderRadius:8,border:`1px solid ${C.brd}`,background:"#fff"}} alt="Logo"/>
              <button onClick={()=>{setJobLogoFile(null);setJobLogoPreview(null);if(jobLogoRef.current)jobLogoRef.current.value="";}} style={{padding:"6px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:6,color:C.lt,fontSize:12,cursor:"pointer"}}>Remove</button>
            </div>
          ):(
            <button onClick={()=>jobLogoRef.current?.click()} style={{padding:"10px 16px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,fontSize:13,cursor:"pointer"}}>Upload Logo</button>
          )}
          <div style={{fontSize:11,color:C.mut,marginTop:4}}>Logo shown on your reports. Uses your company logo if not set.</div>
        </div>)}

        {/* Job Type Toggle */}
        <div style={{marginBottom:20}}>
          <label style={ls}>Report Type</label>
          <div style={{display:"flex",background:C.inp,borderRadius:10,padding:3}}>
            <button onClick={()=>setJobType("template")} style={{flex:1,padding:"12px 0",background:jobType==="template"?C.card:"transparent",border:"none",borderRadius:8,color:jobType==="template"?C.txt:C.mut,fontSize:14,fontWeight:700,cursor:"pointer"}}>
              Template
            </button>
            <button onClick={()=>setJobType("worklog")} style={{flex:1,padding:"12px 0",background:jobType==="worklog"?C.card:"transparent",border:"none",borderRadius:8,color:jobType==="worklog"?C.txt:C.mut,fontSize:14,fontWeight:700,cursor:"pointer"}}>
              Work Log
            </button>
          </div>
          <div style={{fontSize:11,color:C.mut,marginTop:6}}>
            {jobType==="template"?"Upload your PDF template — we copy it and detect all the fields. You fill them daily.":"Track contractors, hours, and work descriptions. Generates a detailed report."}
          </div>
        </div>

        {/* Work Log Template — optional branded PDF as background */}
        {jobType==="worklog"&&(
          <div style={{marginBottom:20}}>
            <label style={ls}>Report Template (Optional)</label>
            <div style={{fontSize:11,color:C.mut,marginBottom:8,lineHeight:1.4}}>Upload a branded PDF to use as the background for your work log reports. The first page will be used as a header with your logo and styling.</div>
            {!tf?(
              <div onClick={()=>document.getElementById("fi_wl").click()}
                style={{border:`2px dashed ${C.brd}`,borderRadius:12,padding:"24px 20px",textAlign:"center",cursor:"pointer",background:C.inp}}>
                <div style={{fontSize:28,marginBottom:6}}>—</div>
                <p style={{color:C.lt,fontSize:13,fontWeight:600,marginBottom:4}}>Tap to upload a branded template</p>
                <p style={{color:C.mut,fontSize:11}}>PDF only • Used as report background</p>
                <input id="fi_wl" type="file" accept=".pdf" style={{display:"none"}} onChange={e=>{if(!e.target.files[0])return;const f=e.target.files[0];setTf(f);const r=new FileReader();r.onload=()=>setTfB64(r.result.split(",")[1]);r.readAsDataURL(f);}}/>
              </div>
            ):(
              <div style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,padding:"14px 16px"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{fontSize:24}}>—</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:600,color:C.txt}}>{tf.name}</div>
                    <div style={{fontSize:12,color:C.ok}}>Template uploaded — will be used as report background</div>
                  </div>
                  <button onClick={()=>{setTf(null);setTfB64(null);}} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:18}}>✕</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Template Section — only for template jobs */}
        {jobType==="template"&&(<>
        <div style={{marginBottom:20}}>
          <label style={ls}>Template</label>

          {/* Saved Templates picker — user's own saved templates */}
          {!tf&&savedTpls.length>0&&(
            <div style={{marginBottom:12}}>
              <button onClick={()=>setShowSaved(!showSaved)} style={{width:"100%",padding:"14px 18px",background:showSaved?C.blu+"18":C.card,border:`2px solid ${C.blu}`,borderRadius:12,color:C.blu,fontSize:15,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span>My Templates ({savedTpls.length})</span>
                <span style={{fontSize:14}}>{showSaved?"▲":"▼"}</span>
              </button>
              {showSaved&&(
                <div style={{marginTop:8,background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,overflow:"hidden",maxHeight:300,overflowY:"auto"}}>
                  {savedTpls.map(t=>{
                    const isThis=loadingTplId===t.id;
                    const isOther=loadingTpl&&!isThis;
                    return(
                    <div key={t.id} style={{padding:"12px 16px",borderBottom:`1px solid ${C.brd}`,display:"flex",alignItems:"center",gap:10,opacity:isOther?0.4:1,background:isThis?"rgba(232,116,42,0.08)":"transparent"}}>
                      <div onClick={()=>{if(!loadingTpl)useSavedTemplate(t);}} style={{display:"flex",alignItems:"center",gap:10,flex:1,cursor:loadingTpl?"default":"pointer"}}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:13,fontWeight:600,color:C.txt}}>{t.name}</div>
                          <div style={{fontSize:11,color:C.mut}}>{(t.field_config||[]).length} fields — {t.file_type?.toUpperCase()}</div>
                        </div>
                        <span style={{color:isThis?C.org:C.blu,fontSize:12,fontWeight:600}}>{isThis?"Loading...":"Use"}</span>
                      </div>
                      <button onClick={async(e)=>{e.stopPropagation();const btn=e.currentTarget;if(btn.disabled)return;btn.disabled=true;if(!await askConfirm("Delete this saved template?")){btn.disabled=false;return;}try{await db.deleteSavedTemplate(t.id);setSavedTpls(p=>p.filter(x=>x.id!==t.id));}catch(err){showToast("Delete failed");btn.disabled=false;}}} style={{background:"none",border:"none",color:C.err,fontSize:14,cursor:"pointer",padding:"4px 6px",flexShrink:0}}>🗑️</button>
                    </div>
                    );
                  })}
                </div>
              )}
              <div style={{textAlign:"center",color:C.mut,fontSize:12,margin:"10px 0"}}>— or upload a new one —</div>
            </div>
          )}

          {/* Upload area */}
          {!tf&&(
            <div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(!f)return;if(!f.name.toLowerCase().endsWith(".pdf")){setErr("Only PDF files are supported.");return;}(usedSavedId?doFileWithSaved:doFile)(f);}} onClick={()=>document.getElementById("fi").click()}
              style={{border:`2px dashed ${drag?C.org:C.brd}`,borderRadius:12,padding:"32px 20px",textAlign:"center",cursor:"pointer",background:drag?"#1f1a14":C.inp}}>
              <div style={{fontSize:32,marginBottom:8}}>—</div>
              <p style={{color:C.lt,fontSize:14,fontWeight:600,marginBottom:4}}>{usedSavedId?"Now upload the actual file (parsing will be skipped)":"Drop your template here"}</p>
              <p style={{color:C.mut,fontSize:12}}>{usedSavedId?"Fields already loaded from saved template":"or tap to browse • PDF only"}</p>
              {!usedSavedId&&<p style={{color:C.mut,fontSize:11,marginTop:8,lineHeight:1.4,fontStyle:"italic"}}>Tip: Download the file to your phone first, then upload from your files.</p>}
              <input id="fi" type="file" accept=".pdf" style={{display:"none"}} onChange={e=>e.target.files[0]&&(usedSavedId?doFileWithSaved:doFile)(e.target.files[0])}/>
            </div>
          )}
          {tf&&(
            <div style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,padding:"14px 16px"}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{fontSize:24}}>—</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:14,fontWeight:600,color:C.txt}}>{tf.name}</div>
                  <div style={{fontSize:12,color:C.mut}}>{usedSavedId?"Using saved template — no parsing needed":"New upload"}</div>
                </div>
                <button onClick={()=>{setTf(null);setTfB64(null);setFields([]);setUsedSavedId(null);setReportTitle("");setFnConvention(null);setTplSaved(false);}} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:18}}>✕</button>
              </div>
            </div>
          )}
        </div>

        {/* Manual field placement — optional, for when auto-detect misses fields */}
        {tf&&!parsing&&tf.name.toLowerCase().endsWith(".pdf")&&tfB64&&(
          <div style={{marginBottom:4,textAlign:"right"}}>
            <button onClick={()=>setShowFieldEditor(true)} style={{background:"none",border:"none",color:C.mut,fontSize:11,cursor:"pointer",textDecoration:"underline",padding:"4px 0"}}>
              {fields.length>0?"Adjust field positions manually":"Place fields manually instead"}
            </button>
          </div>
        )}

        {/* Report Naming Convention — uses the uploaded filename directly */}
        {reportTitle&&(
          <div style={{marginBottom:20}}>
            <label style={ls}>Report Naming Convention</label>
            <input type="text" value={reportTitle} onChange={e=>{setReportTitle(e.target.value);setFnConvention(prev=>prev?{...prev,pattern:e.target.value}:prev);}} style={fs}/>
          </div>
        )}

        {/* AI Parsing indicator with spinner (DOCX only now) */}
        {parsing&&(
          <div style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,padding:"24px",marginBottom:20,textAlign:"center"}}>
            <div style={{width:40,height:40,border:`3px solid ${C.brd}`,borderTop:`3px solid ${C.org}`,borderRadius:"50%",margin:"0 auto 12px",animation:"spin 1s linear infinite"}}/>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            <p style={{color:C.lt,fontSize:14,fontWeight:600,margin:"0 0 4px"}}>Analyzing template fields...</p>
            <p style={{color:C.mut,fontSize:12,margin:0}}>Detecting fillable fields in your document...</p>
          </div>
        )}


        {/* ── Unified Field List ── */}
        {!parsing&&fields.length>0&&(
          <div style={{marginBottom:20}}>
            <div style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,overflow:"hidden"}}>
              <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.brd}`,background:"rgba(232,116,42,0.06)"}}>
                <div style={{fontWeight:700,fontSize:14,color:C.org}}>Template Fields ({fields.length}){fields.some(f=>f.source==="acroform")?" — Fillable PDF":""}</div>
                <div style={{fontSize:11,color:C.mut,marginTop:3}}>{fields.some(f=>f.source==="acroform")?"Fields detected from fillable PDF form. Set each field to Edit, Lock, or Auto.":"Set each field to Edit, Lock, or Auto-Date. Locked fields keep the same value every report."}</div>
              </div>
              <div style={{margin:"10px 8px 6px",padding:"10px 14px",background:"rgba(59,130,246,0.08)",border:"1px solid rgba(59,130,246,0.2)",borderRadius:8,display:"flex",alignItems:"flex-start",gap:8}}>
                <span style={{fontSize:16,flexShrink:0}}>💡</span>
                <div style={{fontSize:12,color:C.lt,lineHeight:1.5}}>
                  <strong>One-time setup!</strong> Just configure these fields once. You can always come back and change them later in Job Settings.
                </div>
              </div>
              <div style={{padding:8}}>
                {fields.filter(f=>{
                  // TYR: hide contractor/MP/manpower/RFI/equipment/trade fields — handled by dedicated sections in ReportEditor
                  if(jobSelectedCompany?.id===TYR_COMPANY_ID||jobSelectedCompany?.id===ENHANCED_TYR_ID){
                    const fn=(f.name||"").toLowerCase();
                    if(/contractor|^mp$|^mp[:\s]|manpower|crew\s*size|rfis|ccds|asis|submittal|equipment|trade/i.test(fn))return false;
                  }
                  return true;
                }).map(f=>(
                  <div key={f.name} style={{padding:"10px 12px",background:f.mode==="lock"&&!f.lockAfterCreate?C.bg:C.card,border:`1px solid ${f.lockAfterCreate?C.org:C.brd}`,borderRadius:8,marginBottom:6,opacity:f.mode==="lock"&&!f.lockAfterCreate?0.7:1}}>
                    {/* Row 1: Field name + mode buttons */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <span style={{fontSize:13,fontWeight:700,color:C.txt,flex:1,marginRight:8}}>{f.name}{f.type==="checkbox"?" ☑":""}</span>
                      {f.mode==="signature"?(
                        <span style={{fontSize:10,fontWeight:700,color:C.mut,background:C.inp,padding:"3px 8px",borderRadius:4}}>Signature</span>
                      ):(
                      <div style={{display:"flex",gap:4,flexShrink:0}}>
                        {modeBtn(f.name,"edit","Edit",C.org)}
                        {modeBtn(f.name,"lock","Lock",C.mut)}
                        {modeBtn(f.name,"auto-date","Auto-Date",C.blu)}
                        {modeBtn(f.name,"auto-num","Auto-#",C.blu)}
                      </div>
                      )}
                    </div>
                    {/* Row 2: Value input — always visible */}
                    {f.mode!=="auto-date"&&f.mode!=="auto-num"&&(
                      <>
                        <input
                          type="text"
                          value={f.value}
                          onChange={e=>setFieldValue(f.name,e.target.value)}
                          placeholder={f.lockAfterCreate?"Enter value for this job...":f.mode==="lock"?"Set locked value...":"Default value (optional)"}
                          style={{width:"100%",padding:"8px 10px",background:f.lockAfterCreate?"rgba(232,116,42,0.06)":f.mode==="lock"?C.inp:C.bg,border:`1px solid ${f.lockAfterCreate?C.org:C.brd}`,borderRadius:6,color:f.mode==="lock"?C.mut:C.txt,fontSize:13,opacity:f.mode==="lock"&&!f.lockAfterCreate?0.6:1}}
                        />
                        {f.lockAfterCreate&&<div style={{fontSize:10,color:C.org,marginTop:4,fontStyle:"italic"}}>Will lock after job is created</div>}
                        {f.mode==="lock"&&!f.lockAfterCreate&&<div style={{fontSize:10,color:C.mut,marginTop:4,fontStyle:"italic"}}>Locked — same value every report</div>}
                      </>
                    )}
                    {f.mode==="auto-date"&&(
                      <div style={{fontSize:11,color:C.blu,fontStyle:"italic",padding:"4px 0"}}>Will auto-fill today's date on each report</div>
                    )}
                    {f.mode==="auto-num"&&(
                      <div style={{fontSize:11,color:C.blu,fontStyle:"italic",padding:"4px 0"}}>Will auto-increment (1, 2, 3...) on each report</div>
                    )}
                    {f.mode==="signature"&&(
                      <div style={{fontSize:11,color:C.mut,fontStyle:"italic",padding:"4px 0"}}>Signature field — will be handled at submission</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {/* Save as Reusable Template — after fields so users review first */}
            {!tplSaved&&!usedSavedId&&(
              <div style={{background:C.card,border:`2px solid ${C.blu}`,borderRadius:12,padding:"16px 18px",marginTop:16,textAlign:"center"}}>
                <div style={{fontSize:20,marginBottom:6}}>—</div>
                <div style={{fontSize:14,fontWeight:700,color:C.lt,marginBottom:4}}>Save to My Templates</div>
                <div style={{fontSize:12,color:C.mut,marginBottom:12,lineHeight:1.4}}>Save these fields to your account for reuse on future jobs. Only visible to you.</div>
                <button onClick={saveAsTemplate} disabled={savingTpl} style={{width:"100%",padding:"12px 0",background:C.blu,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:savingTpl?"default":"pointer",opacity:savingTpl?0.6:1}}>
                  {savingTpl?"Saving...":"Save to My Templates"}
                </button>
              </div>
            )}
            {tplSaved&&!usedSavedId&&(
              <div style={{background:"rgba(34,197,94,0.08)",border:`1px solid ${C.ok}`,borderRadius:10,padding:"12px 16px",marginTop:16,textAlign:"center"}}>
                <span style={{fontSize:14,color:C.ok,fontWeight:700}}>Saved to My Templates</span>
              </div>
            )}
          </div>
        )}
        </>)}

        {/* ── Three Toggle Boxes ── */}

        {/* 1. Jobsite Scheduling */}
        <ToggleBox icon="📅" label="Jobsite Scheduling" on={schedOn} setOn={setSchedOn}>
          <div style={{background:C.bg,border:`1px solid ${C.brd}`,borderRadius:8,padding:"12px 14px",marginTop:12}}>
            <p style={{fontSize:13,color:C.lt,lineHeight:1.5}}>Let your GC and subs request site visits through a shared calendar.</p>
            <p style={{fontSize:12,color:C.blu,marginTop:8,fontWeight:600}}>You'll set up the calendar link and team contacts on the job dashboard after creating this job.</p>
          </div>
        </ToggleBox>

        {/* 2. Report Frequency */}
        <ToggleBox icon="—" label="Report Frequency" on={freqOn} setOn={v=>{setFreqOn(v);if(!v)setRemOn(false);}} desc="Set how often you'll file reports for this job">
          <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
            {DS.map(d=>{const a=days.includes(d);return<button key={d} onClick={()=>togDay(d)} style={{width:42,height:42,borderRadius:"50%",border:a?`2px solid ${C.org}`:`1px solid ${C.brd}`,background:a?C.org:"transparent",color:a?"#fff":C.mut,fontWeight:600,fontSize:11,cursor:"pointer"}}>{d}</button>;})}
          </div>
          <div style={{display:"flex",gap:8}}>
            {[{k:"weekly",l:"Weekly"},{k:"as_needed",l:"As Needed"}].map(({k,l})=><button key={k} onClick={()=>preset(k)} style={{padding:"8px 14px",borderRadius:8,border:sched===k?`2px solid ${C.org}`:`1px solid ${C.brd}`,background:sched===k?C.org:"transparent",color:sched===k?"#fff":C.mut,fontWeight:600,fontSize:12,cursor:"pointer"}}>{l}</button>)}
          </div>
        </ToggleBox>

        {/* 3. Reminders — only visible when Report Frequency is on */}
        {freqOn&&(
          <ToggleBox icon="🔔" label="Reminders" on={remOn} setOn={setRemOn} desc="Get reminded before your report is due">
            <div style={{display:"flex",gap:10}}>
              <div style={{flex:1}}><label style={{display:"block",color:C.mut,fontSize:11,marginBottom:4}}>Submit by</label><select value={remT} onChange={e=>setRemT(e.target.value)} style={{width:"100%",padding:"8px 10px",background:C.bg,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:13}}>{TS.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
              <div style={{flex:1}}><label style={{display:"block",color:C.mut,fontSize:11,marginBottom:4}}>Remind me</label><select value={remH} onChange={e=>setRemH(Number(e.target.value))} style={{width:"100%",padding:"8px 10px",background:C.bg,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:13}}>{[1,2,3,4,6].map(h=><option key={h} value={h}>{h} hr{h>1?"s":""} before</option>)}</select></div>
            </div>
          </ToggleBox>
        )}

        {/* Create Button — only requires job name */}
        <button className="btn-o" onClick={create} disabled={!ok||saving} style={{width:"100%",padding:"14px 0",background:ok?C.org:C.brd,border:ok?`1px solid ${C.blu}`:`1px solid ${C.brd}`,borderRadius:10,color:"#fff",fontSize:16,fontWeight:700,cursor:ok&&!saving?"pointer":"default",opacity:saving?0.7:1,marginTop:8}}>{saving?"Creating...":"Create Job"}</button>
      </div>
    </div>
  );
}


export default CreateJob;
