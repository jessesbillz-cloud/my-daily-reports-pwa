import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { C } from '../constants/theme';
import { db } from '../utils/db';
import { AUTH_TOKEN } from '../utils/auth';
import { SB_URL, SB_KEY } from '../constants/supabase';
import MDRLogo from './MDRLogo';

function SetupWizard({user, inviteCompany, onComplete}){
  const [swToast,setSwToast]=useState("");
  const showToast=(m)=>{setSwToast(m);setTimeout(()=>setSwToast(""),3000);};
  const [step,setStep]=useState(0);
  const [saving,setSaving]=useState(false);
  const [fullName,setFullName]=useState(user?.user_metadata?.full_name||"");
  const [companyName,setCompanyName]=useState(inviteCompany||"");
  const [email,setEmail]=useState(user?.email||"");
  const [timezone,setTimezone]=useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [slug,setSlug]=useState(()=>(user?.user_metadata?.full_name||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,""));
  const [readSections,setReadSections]=useState({});
  const [openSections,setOpenSections]=useState({});
  // Company detection state
  const [companyMatches,setCompanyMatches]=useState([]);
  const [selectedCompany,setSelectedCompany]=useState(null); // {id,name} if user chose to join
  const [companySearching,setCompanySearching]=useState(false);
  const companyDebounce=useRef(null);
  // Auto-search company if invite link provided
  useEffect(()=>{if(inviteCompany&&inviteCompany.trim().length>=2)handleCompanyNameChange(inviteCompany);},[]);
  const SECTION_ORDER=["parsing","cleanDoc","notes","photos","bestPractices"];
  const toggleSection=(key)=>{setReadSections(p=>({...p,[key]:true}));setOpenSections(p=>{const wasOpen=p[key];if(wasOpen){const idx=SECTION_ORDER.indexOf(key);const nextKey=idx>=0&&idx<SECTION_ORDER.length-1?SECTION_ORDER[idx+1]:null;const next={};if(nextKey)next[nextKey]=true;return next;}return{[key]:true};});};

  // Company name search — debounced lookup as user types
  const handleCompanyNameChange=(val)=>{
    setCompanyName(val);
    setSelectedCompany(null); // reset selection when typing
    if(companyDebounce.current)clearTimeout(companyDebounce.current);
    if(val.trim().length<2){setCompanyMatches([]);return;}
    companyDebounce.current=setTimeout(async()=>{
      setCompanySearching(true);
      try{
        const matches=await db.searchCompanies(val.trim());
        // Don't show the user's own company (shouldn't exist yet for new signup, but safety)
        setCompanyMatches(matches.filter(m=>m.created_by!==user?.id));
      }catch(e){setCompanyMatches([]);}
      finally{setCompanySearching(false);}
    },400);
  };

  const joinCompany=(company)=>{
    setSelectedCompany(company);
    setCompanyName(company.name); // set the input to the exact company name
    setCompanyMatches([]); // close dropdown
  };

  const clearCompanySelection=()=>{
    setSelectedCompany(null);
  };

  const TZ_OPTIONS=["America/New_York","America/Chicago","America/Denver","America/Phoenix","America/Los_Angeles","America/Anchorage","Pacific/Honolulu"];
  const TZ_LABELS={"America/New_York":"Eastern (ET)","America/Chicago":"Central (CT)","America/Denver":"Mountain (MT)","America/Phoenix":"Arizona (MST)","America/Los_Angeles":"Pacific (PT)","America/Anchorage":"Alaska (AKT)","Pacific/Honolulu":"Hawaii (HT)"};

  const fs={width:"100%",padding:"12px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15};
  const ls={display:"block",color:C.lt,fontSize:13,fontWeight:600,marginBottom:6};
  const cardS={background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:20,marginBottom:16};
  const tipS={background:"rgba(232,116,42,0.08)",border:`1px solid rgba(232,116,42,0.25)`,borderRadius:8,padding:"12px 14px",marginTop:12,fontSize:13,color:C.lt,lineHeight:1.6};

  const WIZARD_STEPS=[
    {title:"Welcome",icon:"✓"},
    {title:"Your Profile",icon:"—"},
    {title:"How It Works",icon:"—"},
    {title:"Template Prep",icon:"—"},
    {title:"Subscription",icon:"—"},
    {title:"Create Account",icon:"→"},
  ];

  const allTemplateRead=readSections.parsing&&readSections.cleanDoc&&readSections.notes&&readSections.photos&&readSections.bestPractices;

  const canAdvance=()=>{
    if(step===1)return fullName.trim().length>0&&email.trim().includes("@")&&slug.trim().length>0;
    if(step===3)return allTemplateRead;
    return true;
  };

  const saveProfileAndFinish=async()=>{
    setSaving(true);
    try{
      let baseSlug=slug.trim()||fullName.trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"");
      let slugVal=baseSlug;
      let attempt=0;

      // Handle company: use assign_company DB function (lookup → fuzzy match → create)
      let companyId=null;
      if(companyName.trim()){
        try{
          companyId=await db.assignCompany(user.id,companyName.trim());
          // Copy company templates to user's saved templates
          if(companyId){
            try{await db.copyCompanyTemplatesDB(user.id,companyId);}catch(e){
              console.error("Template copy RPC:",e);
              // Fallback: fetch company templates and copy manually
              try{const cts=await db.getCompanyTemplates(companyId);if(cts.length)await db.copyCompanyTemplatesToUser(cts,user.id);}catch(e2){console.error("Template copy fallback:",e2);}
            }
          }
        }catch(e){
          console.error("assign_company:",e);
          // Company is optional — continue without if it fails
        }
      }

      // Try saving — if slug conflict, append -2, -3, etc.
      while(true){
        try{
          await db.upsertProfile({id:user.id,full_name:fullName.trim(),company_name:companyName.trim()||null,company_id:companyId,timezone,slug:slugVal});
          break;
        }catch(e){
          const msg=(e.message||"").toLowerCase();
          if(msg.includes("slug")&&(msg.includes("unique")||msg.includes("duplicate"))){
            attempt++;
            slugVal=baseSlug+"-"+(attempt+1);
            if(attempt>20)throw new Error("Could not generate a unique URL. Try a different display name.");
          }else{
            throw e;
          }
        }
      }
      setSlug(slugVal);

      // Mark wizard complete
      try{await db.upsertProfile({id:user.id,setup_complete:true,wizard_completed_at:new Date().toISOString()});}catch(_){}
      onComplete();
    }catch(e){showToast("Save failed — try again");}
    finally{setSaving(false);}
  };

  const next=()=>{if(step<WIZARD_STEPS.length-1)setStep(step+1);};
  const prev=()=>{if(step>0)setStep(step-1);};
  const pct=Math.round((step/(WIZARD_STEPS.length-1))*100);

  return(
    <div style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      {swToast&&<div style={{position:"fixed",bottom:30,left:"50%",transform:"translateX(-50%)",background:"#333",color:"#fff",padding:"10px 20px",borderRadius:8,fontSize:13,zIndex:99999}}>{swToast}</div>}
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 20px",borderBottom:`1px solid ${C.brd}`,background:C.card}}>
        <MDRLogo size={30}/>
        <span style={{fontWeight:700,fontSize:16,flex:1}}>Setup Wizard</span>
        <span style={{fontSize:12,color:C.mut,fontWeight:600}}>Step {step+1} of {WIZARD_STEPS.length}</span>
      </div>
      <div style={{height:3,background:C.brd}}><div style={{height:3,background:C.org,width:pct+"%",transition:"width 0.3s ease"}}/></div>

      <div style={{maxWidth:560,margin:"0 auto",padding:"20px 16px 40px"}}>

        {/* ── Step 0: Welcome ── */}
        {step===0&&(
          <div>
            <div style={{textAlign:"center",padding:"30px 0 20px"}}>
              <MDRLogo size={72}/>
              <h1 style={{fontSize:24,fontWeight:800,marginTop:16,marginBottom:8}}>Welcome to My Daily Reports</h1>
              <p style={{fontSize:15,color:C.lt,lineHeight:1.6,maxWidth:400,margin:"0 auto"}}>Give us about 5 minutes to learn how to set up your first report template. Do it once, and you'll never have to do it again.</p>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {WIZARD_STEPS.slice(1).map((s,i)=>(
                <button key={i} onClick={next} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,cursor:"pointer",textAlign:"left"}}>
                  <span style={{fontSize:20}}>{s.icon}</span>
                  <span style={{fontSize:15,fontWeight:600,color:C.txt,flex:1}}>{s.title}</span>
                  <span style={{color:C.mut,fontSize:14}}>›</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 1: Profile Setup ── */}
        {step===1&&(
          <div>
            <h2 style={{fontSize:20,fontWeight:700,marginBottom:16}}>Your Profile</h2>
            <div style={cardS}>
              <div style={{marginBottom:18}}>
                <label style={ls}>Full Name</label>
                <input type="text" value={fullName} onChange={e=>setFullName(e.target.value)} placeholder="Jesse Saltzman" style={fs}/>
                <div style={{fontSize:11,color:C.mut,marginTop:4}}>Appears on reports and your scheduling page.</div>
              </div>
              <div style={{marginBottom:18,position:"relative"}}>
                <label style={ls}>Company Name</label>
                <input type="text" value={companyName} onChange={e=>handleCompanyNameChange(e.target.value)} placeholder="e.g. ABC Construction" style={fs}/>
                {/* Company match dropdown */}
                {companyMatches.length>0&&!selectedCompany&&(
                  <div style={{position:"absolute",left:0,right:0,top:"100%",zIndex:50,background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,marginTop:4,overflow:"hidden",boxShadow:"0 8px 24px rgba(0,0,0,0.15)"}}>
                    <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.brd}`,fontSize:12,color:C.mut,fontWeight:600}}>Existing company found — want to join?</div>
                    {companyMatches.map(m=>(
                      <button key={m.id} onClick={()=>joinCompany(m)} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"12px 14px",background:"transparent",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:14,fontWeight:600,color:C.txt}}>{m.name}</div>
                          <div style={{fontSize:11,color:C.mut}}>Tap to join and access their templates</div>
                        </div>
                        <span style={{color:C.org,fontSize:13,fontWeight:600}}>Join</span>
                      </button>
                    ))}
                    <button onClick={()=>setCompanyMatches([])} style={{width:"100%",padding:"10px 14px",background:"transparent",border:"none",cursor:"pointer",fontSize:12,color:C.mut,textAlign:"center"}}>
                      No, create a new company with this name
                    </button>
                  </div>
                )}
                {/* Selected company badge */}
                {selectedCompany&&(
                  <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6,padding:"8px 12px",background:"rgba(232,116,42,0.08)",border:`1px solid rgba(232,116,42,0.25)`,borderRadius:8}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:600,color:C.txt}}>Joining {selectedCompany.name}</div>
                      <div style={{fontSize:11,color:C.mut}}>You'll get access to their report templates</div>
                    </div>
                    <button onClick={clearCompanySelection} style={{background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:16,padding:"0 4px"}}>✕</button>
                  </div>
                )}
                {!selectedCompany&&<div style={{fontSize:11,color:C.mut,marginTop:4}}>Emails will appear as: <strong style={{color:C.txt}}>{companyName||"Your Company"} &lt;reports@mydailyreports.org&gt;</strong></div>}
                {!selectedCompany&&<div style={{fontSize:11,color:C.mut,marginTop:2}}>Set this once — it's how your name shows in your recipients' inbox.</div>}
              </div>
              <div style={{marginBottom:18}}>
                <label style={ls}>Email Address</label>
                <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@company.com" style={fs}/>
                <div style={{fontSize:11,color:C.mut,marginTop:4}}>Used for sign-in and report delivery notifications.</div>
              </div>
              <div style={{marginBottom:18}}>
                <label style={ls}>Timezone</label>
                <select value={timezone} onChange={e=>setTimezone(e.target.value)} style={{...fs,cursor:"pointer"}}>
                  {TZ_OPTIONS.map(tz=><option key={tz} value={tz}>{TZ_LABELS[tz]||tz}</option>)}
                </select>
              </div>
              <div>
                <label style={ls}>Calendar Display Name</label>
                <input type="text" value={slug} onChange={e=>setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,""))} placeholder="jesse-saltzman" style={fs}/>
                <div style={{fontSize:12,color:C.blu,marginTop:6,fontWeight:600}}>schedule.mydailyreports.org/{slug||"your-name"}</div>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: How It Works ── */}
        {step===2&&(
          <div>
            <h2 style={{fontSize:20,fontWeight:700,marginBottom:16}}>How It Works</h2>
            <div style={cardS}>
              <p style={{fontSize:14,color:C.lt,lineHeight:1.6,marginBottom:14}}>Upload your PDF template and we make a working copy of it. We detect all the fields and you tell us how each one should work:</p>
              <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
                {[
                  {icon:"✏️",name:"Edit",desc:"Fill in daily — notes, weather, hours"},
                  {icon:"🔒",name:"Lock",desc:"Same every day — project name, contractor"},
                  {icon:"📅",name:"Auto-Date",desc:"Today's date, auto-filled"},
                  {icon:"🔢",name:"Auto-Number",desc:"Sequential report number"},
                ].map((f,i)=>(
                  <div key={i} style={{display:"flex",gap:10,padding:"10px 12px",background:C.inp,borderRadius:8,border:`1px solid ${C.brd}`}}>
                    <span style={{fontSize:16,flexShrink:0}}>{f.icon}</span>
                    <div><span style={{fontWeight:700,fontSize:13,color:C.txt}}>{f.name}</span> <span style={{fontSize:12,color:C.mut}}>— {f.desc}</span></div>
                  </div>
                ))}
              </div>
              <p style={{fontSize:13,color:C.mut,lineHeight:1.5}}>Set up once per job. Every report auto-fills locked fields and gives you blank editable fields to complete.</p>
            </div>
            <div style={cardS}>
              <div style={{fontSize:14,fontWeight:700,color:C.org,marginBottom:8}}>Your Template, Your Format</div>
              <p style={{fontSize:13,color:C.lt,lineHeight:1.6}}>We use your exact PDF — your company logo, layout, and branding stay intact. When you submit, we generate a filled copy with your daily entries. Photos get added on additional pages.</p>
            </div>
            <div style={cardS}>
              <div style={{fontSize:14,fontWeight:700,color:C.blu,marginBottom:8}}>Not Looking Right?</div>
              <p style={{fontSize:13,color:C.lt,lineHeight:1.6}}>If the fields don't look right after upload, try again or send your template to support@mydailyreports.org and we'll set it up for you.</p>
            </div>
            <div style={{fontSize:12,color:C.mut,textAlign:"center",marginTop:4}}>For detailed walkthroughs, visit the Training Center on the dashboard.</div>
          </div>
        )}

        {/* ── Step 3: Template Preparation ── */}
        {step===3&&(
          <div>
            <h2 style={{fontSize:20,fontWeight:700,marginBottom:4}}>Template Preparation</h2>
            <p style={{fontSize:13,color:C.mut,marginBottom:16}}>Tap each section to review. All 5 required before continuing.</p>

            {[
              {key:"parsing",icon:"🔍",title:"What Happens When You Upload",bullets:[
                "We make a copy of your PDF and scan it for fields (Date, Project Name, Notes, etc.)",
                "Fields are detected automatically — fillable PDFs work best",
                "You'll see a list of fields where you can review, adjust, and lock the ones that stay the same every day",
              ]},
              {key:"cleanDoc",icon:"🧹",title:"Preparing Your PDF",bullets:[
                "Your template must be a PDF — fillable PDFs with form fields give the best results",
                "Clear out any old dates, numbers, or sample text before uploading",
                "The cleaner your template, the better the detection",
              ]},
              {key:"notes",icon:"📝",title:"Notes & Observations",bullets:[
                "Label your notes area clearly — \"Notes:\" or \"Observations:\"",
                "Leave the notes area blank so there's room to write each day",
                "Daily entries fill into the same spot on your template every time",
              ]},
              {key:"photos",icon:"📸",title:"Photos",bullets:[
                "Photos get added on new pages after your main report",
                "Your company header and formatting carry through",
                "Upload a single-page template — remove any blank extra pages first",
              ]},
              {key:"bestPractices",icon:"📐",title:"Need Help Creating a Template?",bullets:[
                "Single-page PDF works best, standard letter size (8.5\" x 11\")",
                "Fillable PDFs with form fields give the most accurate results",
                "Don't have a template? Use ChatGPT, Google Gemini, or any AI — just tell it: \"Create a fillable PDF daily inspection report template for [your industry]. Include fields for: Date, Project Name, Inspector Name, Report Number, Weather, Notes/Observations, and a signature line. Single page, 8.5x11, professional layout.\"",
                "If detection doesn't look right, email your template to support@mydailyreports.org and we'll set it up for you",
              ]},
            ].map(section=>{
              const wasRead=readSections[section.key];
              const isOpen=openSections[section.key];
              return(
                <div key={section.key} style={{background:C.card,border:`1px solid ${wasRead?C.org+"60":C.brd}`,borderRadius:10,marginBottom:8,overflow:"hidden"}}>
                  <button onClick={()=>toggleSection(section.key)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px 14px",background:"none",border:"none",cursor:"pointer",textAlign:"left"}}>
                    <span style={{fontSize:16}}>{section.icon}</span>
                    <span style={{flex:1,fontSize:14,fontWeight:700,color:C.txt}}>{section.title}</span>
                    {wasRead&&!isOpen?<span style={{color:C.ok,fontSize:14,fontWeight:700}}>✓</span>:isOpen?<span style={{color:C.mut,fontSize:12}}>▲</span>:<span style={{color:C.mut,fontSize:12}}>▼</span>}
                  </button>
                  {isOpen&&(
                    <div style={{padding:"0 14px 12px",borderTop:`1px solid ${C.brd}`}}>
                      <div style={{paddingTop:10}}>
                        {section.bullets.map((b,i)=>(
                          <div key={i} style={{display:"flex",gap:8,marginBottom:4,fontSize:13,color:C.lt,lineHeight:1.5}}>
                            <span style={{color:C.org,flexShrink:0}}>•</span><span>{b}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {!allTemplateRead&&(
              <div style={{fontSize:12,color:C.mut,textAlign:"center",marginTop:6}}>
                {5-Object.keys(readSections).filter(k=>["parsing","cleanDoc","notes","photos","bestPractices"].includes(k)).length} section{5-Object.keys(readSections).filter(k=>["parsing","cleanDoc","notes","photos","bestPractices"].includes(k)).length!==1?"s":""} remaining
              </div>
            )}
            <div style={{fontSize:12,color:C.mut,textAlign:"center",marginTop:8}}>For more detail on any topic, visit the Training Center on the dashboard.</div>
          </div>
        )}

        {/* ── Step 4: Subscription ── */}
        {step===4&&(
          <div>
            <h2 style={{fontSize:20,fontWeight:700,marginBottom:16}}>⭐ Subscription</h2>
            <div style={{...cardS,textAlign:"center",padding:"24px 20px"}}>
              <div style={{display:"inline-block",background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:20,padding:"6px 16px",marginBottom:10}}>
                <span style={{fontSize:14,fontWeight:700,color:C.ok}}>FREE During Beta</span>
              </div>
              <p style={{fontSize:13,color:C.lt}}>All features included. No payment required yet.</p>
            </div>
            <div style={{background:"rgba(90,143,192,0.08)",border:`1px solid rgba(90,143,192,0.25)`,borderRadius:10,padding:14}}>
              <div style={{fontSize:13,fontWeight:700,color:C.blu,marginBottom:6}}>Coming Soon — $19.99/mo</div>
              <p style={{fontSize:12,color:C.mut}}>You'll be notified before any charges begin.</p>
            </div>
          </div>
        )}

        {/* ── Step 5: You're Ready ── */}
        {step===5&&(
          <div>
            <div style={{textAlign:"center",padding:"30px 0 20px"}}>
              <div style={{fontSize:56,marginBottom:16,color:C.brd}}>→</div>
              <h2 style={{fontSize:22,fontWeight:800,marginBottom:8}}>Almost There!</h2>
              <p style={{fontSize:15,color:C.lt,lineHeight:1.6,maxWidth:400,margin:"0 auto"}}>Create your account to start building jobs and generating reports.</p>
            </div>
            <div style={cardS}>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <div style={{display:"flex",gap:8,alignItems:"center",fontSize:13,color:C.lt}}><span style={{color:C.ok,fontWeight:700}}>✓</span> <strong style={{color:C.txt}}>{fullName}</strong> — {email}</div>
                <div style={{display:"flex",gap:8,alignItems:"center",fontSize:13,color:C.lt}}><span style={{color:C.ok,fontWeight:700}}>✓</span> Calendar: <strong style={{color:C.blu}}>schedule.mydailyreports.org/{slug}</strong></div>
                <div style={{display:"flex",gap:8,alignItems:"center",fontSize:13,color:C.lt}}><span style={{color:C.ok,fontWeight:700}}>✓</span> Template guidelines reviewed</div>
              </div>
            </div>
            <div style={tipS}>
              <strong style={{color:C.org}}>Next:</strong> Tap "Create Account" below, then "+ New Job" to upload your first template. Check the Training Center anytime for detailed guides.
            </div>
          </div>
        )}

        {/* ── Navigation Buttons ── */}
        <div style={{display:"flex",gap:12,marginTop:24}}>
          {step>0&&(
            <button onClick={prev} style={{flex:1,padding:"14px 0",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.lt,fontSize:15,fontWeight:700,cursor:"pointer"}}>Back</button>
          )}
          {step<WIZARD_STEPS.length-1?(
            <button onClick={next} disabled={!canAdvance()} className="btn-o" style={{flex:step===0?1:2,padding:"14px 0",background:canAdvance()?C.org:C.inp,border:canAdvance()?`1px solid ${C.org}`:`1px solid ${C.brd}`,borderRadius:10,color:canAdvance()?"#fff":C.mut,fontSize:15,fontWeight:700,cursor:canAdvance()?"pointer":"default",opacity:canAdvance()?1:0.5}}>
              {step===0?"Let's Get Started":"Continue"}
            </button>
          ):(
            <button onClick={saveProfileAndFinish} disabled={saving} className="btn-o" style={{flex:2,padding:"14px 0",background:C.org,border:`1px solid ${C.org}`,borderRadius:10,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer"}}>
              {saving?"Creating Account...":"Create Account"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


export default SetupWizard;
