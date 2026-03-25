import{useState}from"react";
import{C}from"../constants/theme";
import{db}from"../utils/db";
import{generateTimeCardPDF}from"../utils/timecard";

export default function TimeCardGenerator({job,user,showToast}){
  const [weekEnding,setWeekEnding]=useState(()=>{
    // Default to most recent Sunday
    const d=new Date();const day=d.getDay();
    d.setDate(d.getDate()-day); // go back to Sunday
    return d.toLocaleDateString("en-CA");
  });
  const [generating,setGenerating]=useState(false);

  const getMondayForSunday=(sundayIso)=>{
    const d=new Date(sundayIso+"T12:00:00");
    d.setDate(d.getDate()-6);
    return d.toLocaleDateString("en-CA");
  };

  const fmtDate=(iso)=>{
    if(!iso)return"";
    const d=new Date(iso+"T12:00:00");
    return d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
  };

  // Build download filename from naming convention pattern
  const buildFilename=(pattern,weDate)=>{
    const userName=user?.user_metadata?.full_name||user?.email?.split("@")[0]||"Inspector";
    const dateStr=String(weDate.getMonth()+1).padStart(2,"0")+String(weDate.getDate()).padStart(2,"0")+weDate.getFullYear();
    const weStr=String(weDate.getMonth()+1).padStart(2,"0")+"-"+String(weDate.getDate()).padStart(2,"0")+"-"+weDate.getFullYear();
    return pattern
      .replace(/\{job_name\}/gi,job.name||"Job")
      .replace(/\{date\}/gi,dateStr)
      .replace(/\{company\}/gi,job.timecard_company_name||"")
      .replace(/\{inspector\}/gi,userName)
      .replace(/\{week_ending\}/gi,weStr)
      .replace(/[/\\?*:|"<>]/g,"_"); // sanitize for filename
  };

  const handleGenerate=async()=>{
    if(!weekEnding){showToast("Pick a week-ending date");return;}
    // Validate it's a Sunday
    const d=new Date(weekEnding+"T12:00:00");
    if(d.getDay()!==0){showToast("Week ending date must be a Sunday");return;}

    setGenerating(true);
    try{
      const monday=getMondayForSunday(weekEnding);
      const reports=await db.fetchReportsForWeek(job.id,monday,weekEnding);

      const pdfBytes=await generateTimeCardPDF({job,user,reports:reports||[],weekEndingDate:weekEnding,mondayDate:monday});

      // Trigger download with custom filename
      const blob=new Blob([pdfBytes],{type:"application/pdf"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;
      const weDate=new Date(weekEnding+"T12:00:00");
      const namingPattern=job.field_config?.timecardFileNaming||"TYR Time Card - {job_name}_{date}";
      a.download=buildFilename(namingPattern,weDate)+".pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showToast(reports.length>0?`Time Card generated (${reports.length} day${reports.length>1?"s":""})`:"Time Card generated — no submitted reports for this week");
    }catch(e){
      console.error("Generate time card:",e);
      showToast("Failed: "+e.message);
    }finally{setGenerating(false);}
  };

  const fs={width:"100%",boxSizing:"border-box",padding:"10px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:15};

  // Show current filename preview
  const previewName=weekEnding?(()=>{
    const weDate=new Date(weekEnding+"T12:00:00");
    const pattern=job.field_config?.timecardFileNaming||"TYR Time Card - {job_name}_{date}";
    return buildFilename(pattern,weDate)+".pdf";
  })():"";

  return(
    <div style={{padding:"4px 0",display:"flex",flexDirection:"column",gap:12}}>
      <div>
        <label style={{fontSize:11,color:C.mut,fontWeight:700,display:"block",marginBottom:6,letterSpacing:0.5}}>WEEK ENDING (SUNDAY)</label>
        <input type="date" value={weekEnding||""} onChange={e=>setWeekEnding(e.target.value)} style={fs}/>
        {weekEnding&&(
          <div style={{fontSize:12,color:C.mut,marginTop:6}}>
            {fmtDate(getMondayForSunday(weekEnding))} — {fmtDate(weekEnding)}
          </div>
        )}
      </div>

      <button onClick={handleGenerate} disabled={generating||!weekEnding}
        style={{padding:"14px 0",background:weekEnding&&!generating?C.org:C.brd,border:"none",borderRadius:10,color:"#fff",fontSize:14,fontWeight:700,cursor:generating||!weekEnding?"default":"pointer",opacity:generating||!weekEnding?0.6:1}}>
        {generating?"Generating...":"Generate Time Card"}
      </button>

      {previewName&&(
        <div style={{fontSize:10,color:C.mut,lineHeight:1.4,textAlign:"center",wordBreak:"break-all"}}>
          File: {previewName}
        </div>
      )}

      <div style={{fontSize:11,color:C.mut,lineHeight:1.5,textAlign:"center"}}>
        Pulls Reg/OT/DT hours from submitted daily reports for the selected week.
      </div>
    </div>
  );
}
