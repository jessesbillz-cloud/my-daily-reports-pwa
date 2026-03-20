import { useState } from 'react';
import { C } from '../constants/theme';

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

function TrainingCenter({onBack}){
  const [selGuide,setSelGuide]=useState(null);
  const [step,setStep]=useState(0);

  if(selGuide!==null){
    const g=GUIDES[selGuide];
    const s=g.steps[step];
    return(
      <div style={{minHeight:"100vh",background:C.bg,color:C.txt,display:"flex",flexDirection:"column"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderBottom:`1px solid ${C.brd}`,background:C.card}}>
          <button onClick={()=>{setSelGuide(null);setStep(0);}} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
          <span style={{fontWeight:700,fontSize:17,flex:1}}>{g.title}</span>
        </div>
        <div style={{display:"flex",gap:4,padding:"16px 20px 8px"}}>
          {g.steps.map((_,i)=>(
            <div key={i} style={{flex:1,height:4,borderRadius:2,background:i<=step?(typeof g.color==="string"?g.color:C.org):C.brd,transition:"background 0.3s"}}/>
          ))}
        </div>
        <div style={{textAlign:"center",fontSize:13,fontWeight:600,color:C.mut,marginBottom:16}}>Step {step+1} of {g.steps.length}</div>
        <div style={{flex:1,overflowY:"auto",padding:"0 24px 24px",maxWidth:600,margin:"0 auto",width:"100%"}}>
          <div style={{textAlign:"center",marginBottom:24}}>
            <div style={{width:90,height:90,borderRadius:"50%",background:(typeof g.color==="string"?g.color:C.org)+"22",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",fontSize:42}}>{s.icon}</div>
            <div style={{fontSize:26,fontWeight:700,color:C.txt,marginBottom:12}}>{s.title}</div>
          </div>
          <div style={{fontSize:18,color:C.lt,lineHeight:1.8,marginBottom:20}}>{s.body}</div>
          {s.tip&&(
            <div style={{display:"flex",gap:12,padding:16,background:C.inp,border:`1px solid ${C.brd}`,borderRadius:14,marginBottom:20}}>
              <span style={{fontSize:22,flexShrink:0}}>💡</span>
              <div style={{fontSize:16,color:C.mut,lineHeight:1.6}}>{s.tip}</div>
            </div>
          )}
          {/* Inline illustrations for visual guides */}
          {s.illustration&&s.illustration.type==="form"&&(
            <div style={{background:"#fff",borderRadius:12,padding:16,border:"2px solid "+C.brd,marginBottom:16}}>
              {s.illustration.rows.map((r,ri)=>(
                <div key={ri} style={{marginBottom:ri<s.illustration.rows.length-1?12:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <div style={{display:"flex",alignItems:"center",border:"1px solid #ccc",borderRadius:6,overflow:"hidden",flex:1}}>
                      <div style={{padding:"10px 12px",background:"#f5f5f5",fontWeight:700,fontSize:14,color:"#333",whiteSpace:"nowrap",borderRight:"1px solid #ccc"}}>{r.label}</div>
                      <div style={{padding:"10px 12px",flex:1,fontSize:14,color:r.value?"#333":"#bbb",fontStyle:r.value?"normal":"italic"}}>{r.value||"(blank)"}</div>
                    </div>
                    {r.good&&<span style={{fontSize:18,flexShrink:0}}>✅</span>}
                  </div>
                  {r.note&&<div style={{fontSize:13,color:C.org,fontWeight:600,paddingLeft:4,display:"flex",alignItems:"center",gap:6}}>↑ {r.note}</div>}
                </div>
              ))}
            </div>
          )}
          {s.illustration&&s.illustration.type==="compare"&&(
            <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:16}}>
              <div style={{background:"#fff",borderRadius:12,padding:14,border:"2px solid #ef4444"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#ef4444",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>✕ DON'T</div>
                <div style={{display:"flex",alignItems:"center",border:"1px solid #ccc",borderRadius:6,overflow:"hidden"}}>
                  <div style={{padding:"10px 12px",background:"#f5f5f5",fontWeight:700,fontSize:14,color:"#333",whiteSpace:"nowrap",borderRight:"1px solid #ccc"}}>{s.illustration.bad.label}</div>
                  <div style={{padding:"10px 12px",flex:1,fontSize:14,color:"#333"}}>{s.illustration.bad.value}</div>
                </div>
                <div style={{fontSize:13,color:"#ef4444",marginTop:6,fontWeight:600}}>↑ {s.illustration.bad.caption}</div>
              </div>
              <div style={{background:"#fff",borderRadius:12,padding:14,border:"2px solid "+C.ok}}>
                <div style={{fontSize:12,fontWeight:700,color:C.ok,marginBottom:8,display:"flex",alignItems:"center",gap:6}}>✓ DO</div>
                <div style={{display:"flex",alignItems:"center",border:"1px solid #ccc",borderRadius:6,overflow:"hidden"}}>
                  <div style={{padding:"10px 12px",background:"#f5f5f5",fontWeight:700,fontSize:14,color:"#333",whiteSpace:"nowrap",borderRight:"1px solid #ccc"}}>{s.illustration.good.label}</div>
                  <div style={{padding:"10px 12px",flex:1,fontSize:14,color:s.illustration.good.value?"#333":"#bbb",fontStyle:s.illustration.good.value?"normal":"italic"}}>{s.illustration.good.value||"(blank)"}</div>
                </div>
                <div style={{fontSize:13,color:C.ok,marginTop:6,fontWeight:600}}>↑ {s.illustration.good.caption}</div>
              </div>
            </div>
          )}
          {s.illustration&&s.illustration.type==="checklist"&&(
            <div style={{background:"#fff",borderRadius:12,padding:16,border:"2px solid "+C.brd,marginBottom:16}}>
              {s.illustration.items.map((item,ii)=>(
                <div key={ii} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:ii<s.illustration.items.length-1?"1px solid #eee":"none"}}>
                  <span style={{fontSize:20,flexShrink:0}}>{item.ok?"✅":"❌"}</span>
                  <span style={{fontSize:15,color:"#333",fontWeight:600}}>{item.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{display:"flex",gap:12,padding:"16px 24px 28px",maxWidth:600,margin:"0 auto",width:"100%"}}>
          {step>0&&(
            <button onClick={()=>setStep(step-1)} style={{flex:1,padding:"16px 0",background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,color:C.lt,fontSize:17,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
              ‹ Previous
            </button>
          )}
          <button onClick={()=>{if(step<g.steps.length-1)setStep(step+1);else{setSelGuide(null);setStep(0);}}} className="btn-o" style={{flex:1,padding:"16px 0",background:typeof g.color==="string"?g.color:C.org,border:"none",borderRadius:12,color:"#fff",fontSize:17,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            {step<g.steps.length-1?<>Next ›</>:<>Done ✓</>}
          </button>
        </div>
      </div>
    );
  }

  return(
    <div className="page-in" style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      <div style={{borderBottom:`1px solid ${C.brd}`,background:C.card,padding:"14px 16px"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,maxWidth:600,margin:"0 auto"}}>
        <button onClick={onBack} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <span style={{fontWeight:700,fontSize:17}}>Training Center</span>
      </div>
      </div>
      <div style={{maxWidth:600,margin:"0 auto",padding:"24px"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontSize:56,marginBottom:12}}>🎓</div>
          <div style={{fontSize:26,fontWeight:700,color:C.txt,marginBottom:8}}>Training Center</div>
          <div style={{fontSize:16,color:C.mut,lineHeight:1.5}}>Guides to help you get the most out of My Daily Reports</div>
        </div>
        {GUIDES.map((g,i)=>(
          <button key={i} onClick={()=>{setSelGuide(i);setStep(0);}} style={{width:"100%",display:"flex",alignItems:"center",gap:16,padding:"18px 20px",background:C.card,border:`1px solid ${C.brd}`,borderRadius:16,marginBottom:12,cursor:"pointer",textAlign:"left"}}>
            <div style={{width:56,height:56,borderRadius:14,background:(typeof g.color==="string"?g.color:C.org)+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,flexShrink:0}}>{g.icon}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:18,fontWeight:700,color:C.txt,marginBottom:4}}>{g.title}</div>
              <div style={{fontSize:15,color:C.mut,lineHeight:1.4}}>{g.sub}</div>
            </div>
            <span style={{color:C.mut,fontSize:18}}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default TrainingCenter;
