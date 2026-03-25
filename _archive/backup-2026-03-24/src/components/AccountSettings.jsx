import { askConfirm } from './ConfirmOverlay';
import { useState, useEffect, useRef } from 'react';
import { C } from '../constants/theme';
import { db } from '../utils/db';
import { AUTH_TOKEN } from '../utils/auth';
import { api } from '../utils/api';
import { SB_URL, SB_KEY } from '../constants/supabase';
import SupportChat from './SupportChat';

function AccountSettings({user, onBack, onLogout}){
  const [showSupport,setShowSupport]=useState(false);
  const [profile,setProfile]=useState(null);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [msg,setMsg]=useState("");
  const [msgType,setMsgType]=useState("ok");

  // Form state
  const [fullName,setFullName]=useState(user?.user_metadata?.full_name||"");
  const [companyName,setCompanyName]=useState("");
  const [email,setEmail]=useState(user?.email||"");
  const [timezone,setTimezone]=useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [slug,setSlug]=useState("");
  const [showDelete,setShowDelete]=useState(false);
  const [deleteConfirm,setDeleteConfirm]=useState("");
  const [companyMatches,setCompanyMatches]=useState([]);
  const [selectedCompany,setSelectedCompany]=useState(null);
  const companyDebounce=useRef(null);
  const [companyLogoUrl,setCompanyLogoUrl]=useState(null);
  const [uploadingLogo,setUploadingLogo]=useState(false);
  const logoInputRef=useRef(null);
  const [companyRole,setCompanyRole]=useState("member");
  const [companyTemplates,setCompanyTemplates]=useState([]);
  const [uploadingTpl,setUploadingTpl]=useState(false);
  const tplInputRef=useRef(null);
  const [ntfyTopic,setNtfyTopic]=useState(""); const [pushEnabled,setPushEnabled]=useState(false); const [pushLoading,setPushLoading]=useState(false);
  const defaultPrefs={request_new:true,request_edited:true,request_deleted:true,request_scheduled:true};
  const [notifPrefs,setNotifPrefs]=useState(defaultPrefs);
  const [emailCount,setEmailCount]=useState(null);

  const TZ_OPTIONS = [
    "America/New_York","America/Chicago","America/Denver","America/Phoenix",
    "America/Los_Angeles","America/Anchorage","Pacific/Honolulu"
  ];
  const TZ_LABELS = {
    "America/New_York":"Eastern (ET)","America/Chicago":"Central (CT)",
    "America/Denver":"Mountain (MT)","America/Phoenix":"Arizona (MST)",
    "America/Los_Angeles":"Pacific (PT)","America/Anchorage":"Alaska (AKT)",
    "Pacific/Honolulu":"Hawaii (HT)"
  };

  useEffect(()=>{
    (async()=>{
      try{
        const p=await db.getProfile(user.id);
        if(p){
          setProfile(p);
          if(p.full_name)setFullName(p.full_name);
          if(p.company_name)setCompanyName(p.company_name);
          if(p.company_id){
            setSelectedCompany({id:p.company_id,name:p.company_name||""});
            // Load logo — try localStorage cache first, then fetch from Supabase
            const logoUrl=await db.getCompanyLogoUrl(p.company_id);
            if(logoUrl)setCompanyLogoUrl(logoUrl);
            try{const tpls=await db.getCompanyTemplates(p.company_id);setCompanyTemplates(tpls);}catch(e){}
          }
          if(p.timezone)setTimezone(p.timezone);
          if(p.slug)setSlug(p.slug);
          if(p.company_role)setCompanyRole(p.company_role);
          if(p.ntfy_topic)setNtfyTopic(p.ntfy_topic); if(p.push_subscription)setPushEnabled(true);
          if(p.notification_prefs)setNotifPrefs({...defaultPrefs,...p.notification_prefs});
        }
        // Load email send counter for current month
        try{
          const mo=new Date().toISOString().slice(0,7);
          if(!AUTH_TOKEN){console.warn("No auth token for email counter");return;}
          const cr=await fetch(`${SB_URL}/rest/v1/email_send_counter?month=eq.${mo}&select=*`,{headers:{"apikey":SB_KEY,"Authorization":"Bearer "+AUTH_TOKEN}});
          const rows=await cr.json();
          if(rows&&rows.length>0)setEmailCount(rows[0]);
          else setEmailCount({month:mo,send_count:0,alert_sent:false});
        }catch(e){console.error("Counter load:",e);}
      }catch(e){console.error(e);}
      finally{setLoading(false);}
    })();
  },[]);

  const flash=(m,t="ok")=>{setMsg(m);setMsgType(t);setTimeout(()=>setMsg(""),3000);};

  const handleCompanySearch=(val)=>{
    setCompanyName(val);
    setSelectedCompany(null);
    if(companyDebounce.current)clearTimeout(companyDebounce.current);
    if(val.trim().length<2){setCompanyMatches([]);return;}
    companyDebounce.current=setTimeout(async()=>{
      try{const matches=await db.searchCompanies(val.trim());setCompanyMatches(matches);}catch(e){setCompanyMatches([]);}
    },400);
  };
  const loadCompanyTemplates=async(companyId)=>{
    try{const tpls=await db.getCompanyTemplates(companyId);setCompanyTemplates(tpls);}catch(e){setCompanyTemplates([]);}
  };
  const selectCompany=async(company)=>{
    setSelectedCompany(company);
    setCompanyName(company.name);
    setCompanyMatches([]);
    // Load logo from Supabase (with localStorage cache)
    const logoUrl=await db.getCompanyLogoUrl(company.id);
    setCompanyLogoUrl(logoUrl);
    loadCompanyTemplates(company.id);
  };
  const clearCompany=()=>{
    setSelectedCompany(null);
    setCompanyName("");
    setCompanyMatches([]);
    setCompanyLogoUrl(null);
    setCompanyTemplates([]);
  };
  const handleLogoUpload=async(e)=>{
    const file=e.target.files?.[0];
    if(!file)return;
    if(!selectedCompany){flash("Please select or create a company first","err");if(logoInputRef.current)logoInputRef.current.value="";return;}
    if(!file.type.startsWith("image/")){flash("Please select an image file","err");return;}
    if(file.size>2*1024*1024){flash("Logo must be under 2MB","err");return;}
    setUploadingLogo(true);
    try{
      const logoUrl=await db.uploadCompanyLogo(selectedCompany.id,file,selectedCompany.name);
      setCompanyLogoUrl(logoUrl);
      flash("Company logo saved");
    }catch(err){flash("Logo save failed: "+err.message,"err");}
    finally{setUploadingLogo(false);if(logoInputRef.current)logoInputRef.current.value="";}
  };
  const handleTplUpload=async(e)=>{
    const file=e.target.files?.[0];
    if(!file)return;
    if(!selectedCompany){flash("Select a company first","err");if(tplInputRef.current)tplInputRef.current.value="";return;}
    if(!file.name.toLowerCase().endsWith(".pdf")){flash("Only PDF templates supported","err");if(tplInputRef.current)tplInputRef.current.value="";return;}
    if(file.size>20*1024*1024){flash("File must be under 20MB","err");if(tplInputRef.current)tplInputRef.current.value="";return;}
    setUploadingTpl(true);
    try{
      const saved=await db.uploadCompanyTemplate(selectedCompany.id,file,selectedCompany.name);
      flash("Template uploaded — employees will see it when creating jobs");
      loadCompanyTemplates(selectedCompany.id);
    }catch(err){flash("Upload failed: "+err.message,"err");}
    finally{setUploadingTpl(false);if(tplInputRef.current)tplInputRef.current.value="";}
  };
  const handleDeleteTpl=async(tpl)=>{
    if(!await askConfirm(`Remove "${tpl.template_name}" from company templates?`))return;
    try{
      await db.deleteCompanyTemplate(tpl.id);
      flash("Template removed");
      loadCompanyTemplates(selectedCompany.id);
    }catch(err){flash("Delete failed: "+err.message,"err");}
  };

  const saveProfile=async()=>{
    setSaving(true);
    try{
      const slugVal=slug.trim()||fullName.trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"");
      let companyId=null;
      // If user selected a registered company, assign them
      if(selectedCompany){
        try{
          companyId=await db.assignCompany(user.id,selectedCompany.name);
          // Refresh profile to pick up role set by assign_company
          db._profileCache={};
          const updatedProfile=await db.getProfile(user.id);
          if(updatedProfile?.company_role)setCompanyRole(updatedProfile.company_role);
          // Sync company templates
          if(companyId){try{await db.copyCompanyTemplatesDB(user.id,companyId);}catch(e){console.error("Template sync RPC:",e);try{const cts=await db.getCompanyTemplates(companyId);if(cts.length)await db.copyCompanyTemplatesToUser(cts,user.id);}catch(e2){console.error("Template sync fallback:",e2);}}}
        }catch(e){console.error("Company assign:",e);companyId=selectedCompany.id;}
      }
      const data={
        id:user.id,
        full_name:fullName.trim(),
        company_name:(selectedCompany?.name||companyName).trim()||null,
        company_id:companyId||null,
        timezone,
        slug:slugVal,
        ntfy_topic:ntfyTopic.trim()||("mdr-"+slugVal),
      };
      await db.upsertProfile(data);
      flash("Settings saved successfully");
      setTimeout(()=>onBack(),600);
    }catch(e){
      flash(e.message,"err");
    }finally{setSaving(false);}
  };

  const [deleting,setDeleting]=useState(false);
  const handleDelete=async()=>{
    if(deleteConfirm!=="DELETE MY ACCOUNT"||deleting)return;
    setDeleting(true);
    try{
      await db.deleteAccount(user.id);
      flash("Account deleted — signing out...");
      setTimeout(()=>onLogout(),1500);
    }catch(e){
      flash("Delete failed: "+e.message,"err");
      setDeleting(false);
    }
  };

  const fs={width:"100%",padding:"12px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15};
  const ls={display:"block",color:C.lt,fontSize:13,fontWeight:600,marginBottom:6};

  return(<>
    <div className="page-in" style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      {/* Header */}
      <div style={{borderBottom:`1px solid ${C.brd}`,background:C.card,padding:"14px 16px"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,maxWidth:600,margin:"0 auto"}}>
        <button onClick={onBack} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <span style={{fontWeight:700,fontSize:17}}>Account Settings</span>
      </div>
      </div>

      <div style={{maxWidth:500,margin:"0 auto",padding:"24px 20px"}}>
        {/* Status message */}
        {msg&&(
          <div style={{background:msgType==="ok"?"rgba(34,197,94,0.1)":"#2d1214",border:`1px solid ${msgType==="ok"?"rgba(34,197,94,0.3)":"#5c2023"}`,borderRadius:8,padding:"10px 14px",marginBottom:16,color:msgType==="ok"?C.ok:C.err,fontSize:13,fontWeight:600}}>
            {msg}
          </div>
        )}

        {loading?(
          <p style={{textAlign:"center",color:C.mut,padding:40}}>Loading profile...</p>
        ):(
          <>
            {/* Profile Section */}
            <div style={{marginBottom:28}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
                <div style={{width:48,height:48,borderRadius:"50%",background:C.org,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:20,color:"#fff",flexShrink:0}}>
                  {fullName?fullName.charAt(0).toUpperCase():"?"}
                </div>
                <div>
                  <div style={{fontWeight:700,fontSize:16,color:C.txt}}>{fullName||"Inspector"}</div>
                  <div style={{fontSize:12,color:C.mut}}>{email}</div>
                </div>
              </div>

              <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:20}}>
                <div style={{fontWeight:700,fontSize:15,color:C.txt,marginBottom:16,display:"flex",alignItems:"center",gap:8}}>
                  Profile Information
                </div>

                <div style={{marginBottom:16}}>
                  <label style={ls}>Full Name</label>
                  <input type="text" value={fullName} readOnly style={{...fs,opacity:0.6,cursor:"default"}}/>
                  <div style={{fontSize:11,color:C.mut,marginTop:4}}>Set during sign up</div>
                </div>

                <div style={{marginBottom:16,position:"relative"}}>
                  <label style={ls}>Company</label>
                  {selectedCompany?(
                    <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 12px",background:"rgba(232,116,42,0.08)",border:"1px solid rgba(232,116,42,0.25)",borderRadius:8}}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13,fontWeight:600,color:C.txt}}>{selectedCompany.name}</div>
                        <div style={{fontSize:11,color:C.ok}}>Linked — company templates available</div>
                      </div>
                      <button onClick={clearCompany} style={{background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:16,padding:"0 4px"}}>✕</button>
                    </div>
                  ):(
                    <input type="text" value={companyName} onChange={e=>handleCompanySearch(e.target.value)} placeholder="Search for your company..." style={fs}/>
                  )}
                  {companyMatches.length>0&&!selectedCompany&&(
                    <div style={{position:"absolute",left:0,right:0,top:"100%",zIndex:50,background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,marginTop:4,overflow:"hidden",boxShadow:"0 8px 24px rgba(0,0,0,0.15)"}}>
                      {companyMatches.map(m=>(
                        <button key={m.id} onClick={()=>selectCompany(m)} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"12px 14px",background:"transparent",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
                          <div style={{flex:1}}>
                            <div style={{fontSize:14,fontWeight:600,color:C.txt}}>{m.name}</div>
                            <div style={{fontSize:11,color:C.mut}}>Tap to link your account</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  <div style={{fontSize:11,color:C.mut,marginTop:4}}>
                    {selectedCompany?"This company's templates will be available when creating jobs.":"Type to search for a registered company. This also sets your email sender name."}
                  </div>
                  {selectedCompany&&(
                    <div style={{fontSize:11,color:companyRole==="admin"?C.org:C.mut,marginTop:4}}>
                      Role: <strong>{companyRole==="admin"?"Admin":"Member"}</strong>
                    </div>
                  )}
                  <div style={{fontSize:11,color:C.mut,marginTop:2}}>Emails appear as: <strong style={{color:C.txt}}>{companyName||selectedCompany?.name||"Your Company"} &lt;reports@mydailyreports.org&gt;</strong></div>
                </div>

                {selectedCompany&&(
                  <div style={{marginBottom:16}}>
                    <label style={ls}>Company Logo</label>
                    <div style={{display:"flex",alignItems:"center",gap:12}}>
                      {companyLogoUrl?(
                        <img src={companyLogoUrl} alt="Logo" style={{width:56,height:56,borderRadius:8,objectFit:"contain",background:"#fff",border:`1px solid ${C.brd}`}}/>
                      ):(
                        <div style={{width:56,height:56,borderRadius:8,background:C.inp,border:`1px solid ${C.brd}`,display:"flex",alignItems:"center",justifyContent:"center",color:C.mut,fontSize:11}}>No logo</div>
                      )}
                      <div style={{flex:1}}>
                        <input ref={logoInputRef} type="file" accept="image/*" onChange={handleLogoUpload} style={{display:"none"}}/>
                        <button onClick={()=>logoInputRef.current?.click()} disabled={uploadingLogo} style={{padding:"8px 16px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:13,fontWeight:600,cursor:"pointer"}}>
                          {uploadingLogo?"Uploading...":companyLogoUrl?"Change Logo":"Upload Logo"}
                        </button>
                        <div style={{fontSize:11,color:C.mut,marginTop:4}}>Appears on work log report headers</div>
                      </div>
                    </div>
                  </div>
                )}

                {selectedCompany&&(
                  <div style={{marginBottom:16}}>
                    <label style={ls}>Company Templates</label>
                    <div style={{fontSize:11,color:C.mut,marginBottom:8}}>Upload PDF templates for all {selectedCompany.name} employees</div>
                    {companyTemplates.length>0&&(
                      <div style={{marginBottom:8,maxHeight:240,overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
                        {companyTemplates.map(t=>(
                          <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,marginBottom:4}}>
                            <span style={{fontSize:18}}>📄</span>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontSize:13,fontWeight:600,color:C.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.template_name}</div>
                              <div style={{fontSize:11,color:C.mut}}>{t.file_name}</div>
                            </div>
                            <button onClick={()=>handleDeleteTpl(t)} style={{background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:14,padding:"2px 6px"}}>✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                    <input ref={tplInputRef} type="file" accept=".pdf" onChange={handleTplUpload} style={{display:"none"}}/>
                    <button onClick={()=>tplInputRef.current?.click()} disabled={uploadingTpl} style={{padding:"8px 16px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:13,fontWeight:600,cursor:"pointer"}}>
                      {uploadingTpl?"Uploading...":"Upload Template PDF"}
                    </button>
                    <div style={{fontSize:11,color:C.mut,marginTop:4}}>Employees see these when they select {selectedCompany.name} on Create Job</div>
                  </div>
                )}

                <div style={{marginBottom:16}}>
                  <label style={ls}>Email</label>
                  <input type="email" value={email} readOnly style={{...fs,opacity:0.6,cursor:"default"}}/>
                  <div style={{fontSize:11,color:C.mut,marginTop:4}}>Set during sign up</div>
                </div>

                <div style={{marginBottom:0}}>
                  <label style={ls}>Calendar Display Name</label>
                  <input type="text" value={slug} onChange={e=>setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,""))} placeholder="jesse-saltzman" style={fs}/>
                  <div style={{fontSize:12,color:C.mut,marginTop:6,lineHeight:1.4}}>This is how your name appears at the end of your scheduling URL</div>
                  <a href={`${window.location.origin}${window.location.pathname.replace(/index\.html$/,"").replace(/\/$/,"")}/hub.html?i=${slug||"your-name"}`} target="_blank" rel="noopener" style={{fontSize:12,color:C.blu,marginTop:4,fontWeight:600,display:"block",cursor:"pointer"}}>hub.html?i={slug||"your-name"}</a>
                </div>
              </div>
            </div>

            {/* Timezone Section */}
            <div style={{marginBottom:28}}>
              <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:20}}>
                <div style={{fontWeight:700,fontSize:15,color:C.txt,marginBottom:16,display:"flex",alignItems:"center",gap:8}}>
                  Timezone
                </div>
                <div style={{marginBottom:8}}>
                  <label style={ls}>Your Timezone</label>
                  <select value={timezone} onChange={e=>setTimezone(e.target.value)} style={{...fs,cursor:"pointer"}}>
                    {TZ_OPTIONS.map(tz=>(
                      <option key={tz} value={tz}>{TZ_LABELS[tz]||tz}</option>
                    ))}
                  </select>
                </div>
                <div style={{fontSize:12,color:C.mut}}>
                  Current time: {new Date().toLocaleTimeString("en-US",{timeZone:timezone,hour:"numeric",minute:"2-digit",hour12:true})}
                </div>
              </div>
            </div>

            {/* Notifications Section */}
            <div style={{marginBottom:28}}>
              <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:20}}>
                <div style={{fontWeight:700,fontSize:15,color:C.txt,marginBottom:16,display:"flex",alignItems:"center",gap:8}}>
                  Notifications
                </div>
                <div style={{fontSize:13,color:C.mut,lineHeight:1.6,marginBottom:14}}>
                  Get push notifications on your phone when scheduling requests come in and when reports are due.
                </div>

                <div>
                  <div style={{fontSize:14,fontWeight:600,color:C.lt,marginBottom:8}}>Push Notifications</div>
                  <div style={{fontSize:12,color:C.mut,lineHeight:1.6,marginBottom:10}}>
                    Scheduling alerts and report reminders delivered directly to your device. No extra apps needed.
                  </div>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div><div style={{fontSize:13,fontWeight:600,color:pushEnabled?C.ok:C.lt}}>{pushEnabled?"Notifications Enabled":"Notifications Off"}</div><div style={{fontSize:11,color:C.mut}}>{pushEnabled?"You will receive alerts for new requests":"Tap to enable push alerts"}</div></div>
                    <button onClick={async()=>{if(pushEnabled){setPushEnabled(false);try{const reg=await navigator.serviceWorker.ready;const sub=await reg.pushManager.getSubscription();if(sub)await sub.unsubscribe();await api.rest.patchProfile(user.id,{push_subscription:null});flash("Push notifications disabled");}catch(e){flash("Error: "+e.message,"err");}return;}setPushLoading(true);try{if(!window.matchMedia("(display-mode: standalone)").matches&&!window.navigator.standalone){flash("Install My Daily Reports to your home screen first to enable push notifications.","err");setPushLoading(false);return;}const perm=await Notification.requestPermission();if(perm!=="granted"){flash("Permission denied — check browser settings","err");setPushLoading(false);return;}const reg=await navigator.serviceWorker.ready;const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:"BIYqy5Y2mBafWr4QkgR2WHqS305qoHug2LzpAH-pgWoxn94MORgNzTc0t_nSUygPLxBkPQzEjX8rMZDKb_qYsKM"});const subJson=sub.toJSON();await api.rest.patchProfile(user.id,{push_subscription:subJson});setPushEnabled(true);flash("Push notifications enabled!");}catch(e){flash("Error: "+e.message,"err");}finally{setPushLoading(false);}}} disabled={pushLoading} style={{padding:"10px 20px",borderRadius:8,border:"none",fontWeight:700,fontSize:13,cursor:pushLoading?"wait":"pointer",background:pushEnabled?C.err:C.ok,color:"#fff",opacity:pushLoading?0.6:1}}>{pushLoading?"...":(pushEnabled?"Disable":"Enable")}</button>
                  </div>
                </div>

                {/* Email Notification Preferences */}
                <div style={{marginTop:20,borderTop:`1px solid ${C.brd}`,paddingTop:16}}>
                  <div style={{fontSize:14,fontWeight:600,color:C.lt,marginBottom:8}}>Email Notifications</div>
                  <div style={{fontSize:12,color:C.mut,lineHeight:1.6,marginBottom:12}}>
                    Choose which scheduling events send you email notifications.
                  </div>
                  {[
                    {key:"request_new",label:"New request submitted"},
                    {key:"request_edited",label:"Request edited"},
                    {key:"request_deleted",label:"Request deleted"},
                    {key:"request_scheduled",label:"Request scheduled / confirmed"},
                  ].map(({key,label})=>(
                    <div key={key} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${C.brd}`}}>
                      <span style={{fontSize:13,color:C.lt}}>{label}</span>
                      <button onClick={async()=>{const updated={...notifPrefs,[key]:!notifPrefs[key]};setNotifPrefs(updated);try{await api.rest.patchProfile(user.id,{notification_prefs:updated});flash(updated[key]?"Enabled":"Disabled");}catch(e){flash("Save failed","err");}}} style={{width:48,height:26,borderRadius:13,border:"none",background:notifPrefs[key]?C.ok:C.brd,cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
                        <div style={{width:20,height:20,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:notifPrefs[key]?25:3,transition:"left 0.2s"}}/>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Subscription Section — HIDDEN until post-launch */}
            {false&&<div style={{marginBottom:28}}>
              <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:20}}>
                <div style={{fontWeight:700,fontSize:15,color:C.txt,marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                  Subscription
                </div>
                {(()=>{
                  const ss=profile?.subscription_status||"trialing";
                  const isActive=ss==="active";
                  const isTrial=ss==="trialing";
                  const trialEnd=profile?.trial_ends_at?new Date(profile.trial_ends_at):null;
                  const trialDays=trialEnd?Math.max(0,Math.ceil((trialEnd-new Date())/(1000*60*60*24))):0;
                  return <>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                      <div>
                        <div style={{fontSize:14,fontWeight:600,color:C.txt}}>{isActive?"Subscribed":isTrial?"Free Trial":"Inactive"}</div>
                        <div style={{fontSize:12,color:isActive?C.ok:isTrial?C.org:C.err,fontWeight:600}}>
                          {isActive?"Active":isTrial?`${trialDays} days remaining`:"Expired"}
                        </div>
                      </div>
                      <div style={{background:isActive?"rgba(34,197,94,0.1)":isTrial?"rgba(232,116,42,0.1)":"rgba(239,68,68,0.1)",border:`1px solid ${isActive?"rgba(34,197,94,0.3)":isTrial?"rgba(232,116,42,0.3)":"rgba(239,68,68,0.3)"}`,borderRadius:8,padding:"6px 12px"}}>
                        <span style={{fontSize:12,fontWeight:700,color:isActive?C.ok:isTrial?C.org:C.err}}>{isActive?"$19.99/mo":isTrial?"TRIAL":"EXPIRED"}</span>
                      </div>
                    </div>
                    {isActive&&(
                      <button onClick={async()=>{
                        try{const d=await api.manageSubscription({user_id:user.id,action:"portal"});if(d.url)window.location.href=d.url;}catch(e){flash(e.message,"err");}
                      }} style={{width:"100%",padding:"10px 0",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,fontSize:13,fontWeight:600,cursor:"pointer",marginBottom:8}}>
                        Manage Billing
                      </button>
                    )}
                    {(isTrial||ss==="expired"||ss==="cancelled")&&(
                      <div style={{marginTop:8}}>
                        <div style={{fontSize:12,color:C.mut,marginBottom:10}}>Subscribe to keep using My Daily Reports after your trial ends.</div>
                        <div style={{display:"flex",gap:8}}>
                          <button onClick={async()=>{
                            const pid=localStorage.getItem("mdr_price_monthly")||"";
                            if(!pid){flash("Stripe not configured yet","err");return;}
                            try{const d=await api.createCheckout({user_id:user.id,price_id:pid});if(d.url)window.location.href=d.url;else flash(d.error||"Error","err");}catch(e){flash(e.message,"err");}
                          }} style={{flex:1,padding:"10px 0",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                            $19.99/mo
                          </button>
                          <button onClick={async()=>{
                            const pid=localStorage.getItem("mdr_price_annual")||"";
                            if(!pid){flash("Stripe not configured yet","err");return;}
                            try{const d=await api.createCheckout({user_id:user.id,price_id:pid});if(d.url)window.location.href=d.url;else flash(d.error||"Error","err");}catch(e){flash(e.message,"err");}
                          }} style={{flex:1,padding:"10px 0",background:C.blu,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                            $199/yr
                          </button>
                        </div>
                        <div style={{fontSize:11,color:C.mut,marginTop:8,lineHeight:1.5}}>
                          PayPal and Venmo available at checkout. For Zelle or crypto, email support@mydailyreports.org
                        </div>
                      </div>
                    )}
                  </>;
                })()}
              </div>
            </div>}

            {/* Save Button */}
            <button className="btn-o" onClick={saveProfile} disabled={saving} style={{width:"100%",padding:"14px 0",background:C.org,border:"none",borderRadius:10,color:"#fff",fontSize:16,fontWeight:700,cursor:saving?"default":"pointer",opacity:saving?0.7:1,marginBottom:28}}>
              {saving?"Saving...":"Save Settings"}
            </button>

            {/* Danger Zone */}
            <div style={{marginBottom:28}}>
              <div style={{background:C.card,border:"1px solid #5c2023",borderRadius:12,padding:20}}>
                <div style={{fontWeight:700,fontSize:15,color:C.err,marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                  <span>⚠️</span> Danger Zone
                </div>

                {!showDelete?(
                  <button onClick={()=>setShowDelete(true)} style={{width:"100%",padding:"12px 16px",background:"transparent",border:"1px solid #5c2023",borderRadius:8,color:C.err,fontSize:14,fontWeight:600,cursor:"pointer"}}>
                    Delete My Account
                  </button>
                ):(
                  <div>
                    <div style={{fontSize:13,color:C.err,lineHeight:1.5,marginBottom:12}}>
                      This will permanently delete your account, all jobs, all reports, and all data. This action cannot be undone.
                    </div>
                    <div style={{marginBottom:12}}>
                      <label style={{...ls,color:C.err}}>Type "DELETE MY ACCOUNT" to confirm</label>
                      <input type="text" value={deleteConfirm} onChange={e=>setDeleteConfirm(e.target.value)} placeholder="DELETE MY ACCOUNT" style={{...fs,borderColor:"#5c2023"}}/>
                    </div>
                    <div style={{display:"flex",gap:10}}>
                      <button onClick={()=>{setShowDelete(false);setDeleteConfirm("");}} style={{flex:1,padding:"10px 0",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,fontSize:14,fontWeight:600,cursor:"pointer"}}>
                        Cancel
                      </button>
                      <button onClick={handleDelete} disabled={deleteConfirm!=="DELETE MY ACCOUNT"||deleting} style={{flex:1,padding:"10px 0",background:deleteConfirm==="DELETE MY ACCOUNT"&&!deleting?"#ef4444":C.brd,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:deleteConfirm==="DELETE MY ACCOUNT"&&!deleting?"pointer":"default",opacity:deleteConfirm==="DELETE MY ACCOUNT"?1:0.5}}>
                        {deleting?"Deleting...":"Delete Permanently"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Sign Out */}
            <button onClick={onLogout} style={{width:"100%",padding:"14px 16px",background:"transparent",border:`1px solid ${C.brd}`,borderRadius:10,color:C.err,fontSize:15,fontWeight:600,cursor:"pointer",marginBottom:20,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              Sign Out
            </button>

            <div style={{textAlign:"center",padding:"12px 0 24px",color:"#444",fontSize:11}}>
              My Daily Reports v1.0 • Built in San Diego, CA
            </div>
          </>
        )}
      </div>
    </div>
    <SupportChat user={user}/>
  </>);
}


export default AccountSettings;
