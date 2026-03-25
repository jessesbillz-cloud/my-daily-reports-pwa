import { useState } from 'react';
import { C } from '../constants/theme';

function ArchivedJobs({jobs, onBack, onSelect}){
  return(
    <div className="page-in" style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      <div style={{borderBottom:`1px solid ${C.brd}`,background:C.card,padding:"14px 16px"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,maxWidth:600,margin:"0 auto"}}>
        <button onClick={onBack} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <span style={{fontWeight:700,fontSize:17}}>Archived Jobs</span>
        <span style={{fontSize:13,color:C.mut,marginLeft:"auto"}}>{jobs.length} job{jobs.length!==1?"s":""}</span>
      </div>
      </div>
      <div style={{maxWidth:600,margin:"0 auto",padding:"20px"}}>
        {jobs.length===0&&(<div style={{textAlign:"center",padding:"60px 20px",color:C.mut}}><div style={{fontSize:48,marginBottom:16,color:C.brd}}>—</div><p style={{fontSize:16,fontWeight:600,color:C.lt,marginBottom:6}}>No archived jobs</p><p style={{fontSize:14}}>Completed projects will appear here</p></div>)}
        {jobs.map(j=>(
          <button key={j.id} onClick={()=>onSelect(j)} style={{width:"100%",textAlign:"left",background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:"16px 18px",marginBottom:10,cursor:"pointer",display:"flex",alignItems:"center",gap:14}}>
            <div style={{fontSize:16,fontWeight:700,color:C.mut}}>—</div>
            <div style={{flex:1,minWidth:0}}><div style={{fontWeight:600,fontSize:16,color:C.txt,marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{j.name}</div><div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:11,fontWeight:600,background:C.inp,border:`1px solid ${C.brd}`,borderRadius:6,padding:"2px 8px",color:C.mut}}>{j.schedule}</span>{j.site_address&&<span style={{fontSize:12,color:C.mut,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{j.site_address}</span>}</div></div>
            <span style={{color:C.mut,fontSize:18}}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default ArchivedJobs;
