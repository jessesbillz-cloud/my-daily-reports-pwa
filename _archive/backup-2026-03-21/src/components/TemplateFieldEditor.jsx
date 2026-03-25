import { useState, useEffect, useRef } from 'react';
import { C } from '../constants/theme';
import { ensurePdfJs } from '../utils/pdf';
import { extractPdfTextStructure } from '../utils/auth';

function TemplateFieldEditor({pdfBase64,initialFields,onDone,onCancel}){
  const canvasRef=useRef(null);
  const overlayRef=useRef(null);
  const [pdfDoc,setPdfDoc]=useState(null);
  const [pageNum,setPageNum]=useState(1);
  const [numPages,setNumPages]=useState(1);
  const [fields,setFields]=useState(initialFields||[]);
  const [scale,setScale]=useState(1); // canvas px / PDF pt
  const [pageW,setPageW]=useState(612);
  const [pageH,setPageH]=useState(792);
  const [modal,setModal]=useState(null); // {idx} or {x,y,w,h,page} for new
  const [modalName,setModalName]=useState("");
  const [modalType,setModalType]=useState("text");
  const [modalMode,setModalMode]=useState("edit");
  const [dragging,setDragging]=useState(null); // {idx,startX,startY,origX,origY}
  const [resizing,setResizing]=useState(null); // {idx,startX,startY,origW,origH}
  const [loading,setLoading]=useState(true);
  const [nearbyText,setNearbyText]=useState(""); // text near click for auto-suggest
  const [textItems,setTextItems]=useState([]); // extracted text items for name suggestions
  const FIELD_PRESETS=["Date","Weather","Crew Size","Notes","Signature","Inspector","Project Name","Project No"];

  // Load PDF
  useEffect(()=>{
    if(!pdfBase64)return;
    (async()=>{
      try{
        await ensurePdfJs();
        const raw=atob(pdfBase64);const u8=new Uint8Array(raw.length);
        for(let i=0;i<raw.length;i++)u8[i]=raw.charCodeAt(i);
        const doc=await window.pdfjsLib.getDocument({data:u8}).promise;
        setPdfDoc(doc);setNumPages(doc.numPages);
        // Extract text items for nearby-text suggestions
        try{
          const items=await extractPdfTextStructure(u8);
          setTextItems(items);
        }catch(e){console.error("Text extraction for suggestions:",e);}
      }catch(e){console.error("PDF load error:",e);}
      finally{setLoading(false);}
    })();
  },[pdfBase64]);

  // Render current page — handles rotation, high-DPI, and explicit CSS sizing
  useEffect(()=>{
    if(!pdfDoc||!canvasRef.current)return;
    (async()=>{
      const page=await pdfDoc.getPage(pageNum);
      // Account for PDF rotation metadata
      const vp=page.getViewport({scale:1,rotation:page.rotate||0});
      // Scale to fit container width (max ~360px on mobile)
      const container=canvasRef.current.parentElement;
      const maxW=container?container.clientWidth-8:360;
      const s=maxW/vp.width;
      setScale(s);setPageW(vp.width);setPageH(vp.height);
      const svp=page.getViewport({scale:s,rotation:page.rotate||0});
      const cvs=canvasRef.current;
      const dpr=window.devicePixelRatio||1;
      // Set internal resolution for high-DPI (iPhone retina)
      cvs.width=Math.round(svp.width*dpr);
      cvs.height=Math.round(svp.height*dpr);
      // Set CSS display size to match logical pixels exactly — prevents double-scaling
      cvs.style.width=Math.round(svp.width)+"px";
      cvs.style.height=Math.round(svp.height)+"px";
      const ctx=cvs.getContext("2d");
      ctx.scale(dpr,dpr);
      await page.render({canvasContext:ctx,viewport:svp}).promise;
    })();
  },[pdfDoc,pageNum]);

  // Find nearby text for auto-suggest field name
  const findNearbyText=(clickX,clickY,pg)=>{
    // clickX/clickY are in PDF points
    let best="";let bestDist=Infinity;
    textItems.filter(t=>t.page===pg).forEach(t=>{
      const cx=t.x+t.w/2;const cy=t.y+t.h/2;
      const dist=Math.sqrt((cx-clickX)**2+(cy-clickY)**2);
      if(dist<bestDist&&dist<80){bestDist=dist;best=t.str;}
    });
    return best;
  };

  // Handle tap on overlay to place a new field
  const handlePointerDown=(e)=>{
    if(dragging||resizing)return;
    const rect=overlayRef.current.getBoundingClientRect();
    const px=e.clientX-rect.left;
    const py=e.clientY-rect.top;
    // Check if tapping on existing field (handled by field's own handler)
    // Convert to PDF coords
    const pdfX=px/scale;
    const pdfY=py/scale;
    // Default field size in PDF points (small — user resizes to fit)
    const defW=100,defH=16;
    const nearby=findNearbyText(pdfX,pdfY,pageNum);
    // Clean up nearby text to make a good field name suggestion
    let suggestion=nearby.replace(/[:_\-\.]+$/,"").trim();
    // If it looks like a label (short, no numbers), use it
    if(suggestion.length>30||/^\d+$/.test(suggestion))suggestion="";
    setNearbyText(suggestion);
    setModalName(suggestion);
    setModalType(suggestion.toLowerCase().includes("note")||suggestion.toLowerCase().includes("comment")?"textarea":"text");
    setModalMode(suggestion.toLowerCase().includes("date")?"auto-date":"edit");
    setModal({x:pdfX,y:pdfY,w:defW,h:defH,page:pageNum,isNew:true});
  };

  // Save field from modal
  const saveField=()=>{
    if(!modalName.trim())return;
    const entry={
      id:modal.isNew?(typeof crypto!=="undefined"&&crypto.randomUUID?crypto.randomUUID():"fld_"+Date.now()+"_"+Math.random().toString(36).slice(2,6)):modal.id||undefined,
      name:modalName.trim(),
      value:"",
      mode:modalMode,
      page:modal.page||pageNum,
      x:snap(Math.round(modal.x*100)/100),
      y:snap(Math.round(modal.y*100)/100),
      w:snap(Math.round((modal.w||100)*100)/100),
      h:snap(Math.round((modal.h||(modalType==="textarea"?60:16))*100)/100),
      fontSize:modalType==="textarea"?10:12,
      multiline:modalType==="textarea",
      voiceEnabled:modalType!=="signature",
      fieldType:modalType
    };
    if(modal.isNew){
      setFields(prev=>[...prev,entry]);
    }else{
      // Editing existing field
      setFields(prev=>prev.map((f,i)=>i===modal.idx?{...f,...entry}:f));
    }
    setModal(null);setModalName("");
  };

  // Delete field
  const deleteField=(idx)=>{
    setFields(prev=>prev.filter((_,i)=>i!==idx));
    setModal(null);
  };

  // Field drag handler
  const startDrag=(e,idx)=>{
    e.stopPropagation();e.preventDefault();
    const rect=overlayRef.current.getBoundingClientRect();
    setDragging({idx,startX:e.clientX-rect.left,startY:e.clientY-rect.top,origX:fields[idx].x,origY:fields[idx].y});
  };
  const onPointerMove=(e)=>{
    if(!overlayRef.current)return;
    const rect=overlayRef.current.getBoundingClientRect();
    const px=e.clientX-rect.left;const py=e.clientY-rect.top;
    if(dragging){
      const dx=(px-dragging.startX)/scale;
      const dy=(py-dragging.startY)/scale;
      setFields(prev=>prev.map((f,i)=>i===dragging.idx?{...f,x:snap(Math.max(0,dragging.origX+dx)),y:snap(Math.max(0,dragging.origY+dy))}:f));
    }
    if(resizing){
      const dx=(px-resizing.startX)/scale;
      const dy=(py-resizing.startY)/scale;
      setFields(prev=>prev.map((f,i)=>i===resizing.idx?{...f,w:snap(Math.max(40,resizing.origW+dx)),h:snap(Math.max(16,resizing.origH+dy))}:f));
    }
  };
  const onPointerUp=()=>{setDragging(null);setResizing(null);};

  // Snap to 4px grid in PDF pts
  const snap=(v)=>Math.round(v/4)*4;

  const pageFields=fields.filter(f=>f.page===pageNum);

  if(loading)return(
    <div style={{padding:40,textAlign:"center"}}>
      <div style={{width:36,height:36,border:`3px solid ${C.brd}`,borderTop:`3px solid ${C.org}`,borderRadius:"50%",margin:"0 auto 12px",animation:"spin 1s linear infinite"}}/>
      <p style={{color:C.mut,fontSize:14}}>Loading template preview...</p>
    </div>
  );

  return(
    <div style={{background:C.bg,color:C.txt}}>
      {/* Header */}
      <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.brd}`,background:C.card,display:"flex",alignItems:"center",gap:10}}>
        <button onClick={onCancel} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <div style={{flex:1}}>
          <div style={{fontWeight:700,fontSize:15}}>Place Fields</div>
          <div style={{fontSize:11,color:C.mut}}>Tap where each field should go • {fields.length} field{fields.length!==1?"s":""} placed</div>
        </div>
        <button onClick={()=>onDone(fields)} disabled={fields.length===0} style={{padding:"8px 16px",background:fields.length?C.org:C.brd,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:fields.length?"pointer":"default",opacity:fields.length?1:0.5}}>Done</button>
      </div>

      {/* Quick preset buttons */}
      <div style={{padding:"8px 16px",display:"flex",gap:6,overflowX:"auto",WebkitOverflowScrolling:"touch",borderBottom:`1px solid ${C.brd}`}}>
        {FIELD_PRESETS.map(p=>(
          <button key={p} onClick={()=>{setModalName(p);setModalType(p==="Notes"?"textarea":p==="Signature"?"signature":"text");setModalMode(p==="Date"?"auto-date":["Project Name","Project No","Inspector"].includes(p)?"lock":"edit");setModal({x:pageW/2-50,y:pageH/2-8,w:100,h:p==="Notes"?60:p==="Signature"?28:16,page:pageNum,isNew:true});}}
            style={{padding:"6px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:16,color:C.lt,fontSize:11,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
            + {p}
          </button>
        ))}
      </div>

      {/* Page navigation */}
      {numPages>1&&(
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,padding:"8px 0",borderBottom:`1px solid ${C.brd}`}}>
          <button onClick={()=>setPageNum(p=>Math.max(1,p-1))} disabled={pageNum<=1} style={{background:"none",border:"none",color:pageNum>1?C.blu:C.brd,fontSize:20,cursor:pageNum>1?"pointer":"default"}}>‹</button>
          <span style={{fontSize:13,color:C.lt,fontWeight:600}}>Page {pageNum} of {numPages}</span>
          <button onClick={()=>setPageNum(p=>Math.min(numPages,p+1))} disabled={pageNum>=numPages} style={{background:"none",border:"none",color:pageNum<numPages?C.blu:C.brd,fontSize:20,cursor:pageNum<numPages?"pointer":"default"}}>›</button>
        </div>
      )}

      {/* Canvas + overlay */}
      <div style={{padding:"8px",overflow:"auto",WebkitOverflowScrolling:"touch"}}>
        <div style={{position:"relative",display:"inline-block",boxShadow:"0 2px 12px rgba(0,0,0,0.5)",borderRadius:4,overflow:"hidden"}}>
          <canvas ref={canvasRef} style={{display:"block"}}/>
          {/* Clickable overlay */}
          <div ref={overlayRef}
            onPointerDown={handlePointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",cursor:"crosshair",touchAction:"none"}}>
            {/* Rendered field boxes */}
            {pageFields.map((f,i)=>{
              const realIdx=fields.indexOf(f);
              const isActive=modal&&!modal.isNew&&modal.idx===realIdx;
              return(
                <div key={realIdx}
                  onPointerDown={(e)=>startDrag(e,realIdx)}
                  onClick={(e)=>{e.stopPropagation();setModalName(f.name);setModalType(f.fieldType||"text");setModalMode(f.mode);setModal({...f,idx:realIdx,isNew:false});}}
                  style={{position:"absolute",left:f.x*scale,top:f.y*scale,width:f.w*scale,height:f.h*scale,
                    background:isActive?"rgba(232,116,42,0.12)":"rgba(232,116,42,0.05)",
                    border:isActive?`2px solid ${C.org}`:"1px dashed rgba(232,116,42,0.5)",
                    borderRadius:2,cursor:"move",touchAction:"none",
                    display:"flex",alignItems:"center",padding:"0 3px",boxSizing:"border-box"}}>
                  <span style={{fontSize:Math.max(7,Math.min(10,f.h*scale*0.45)),color:"rgba(232,116,42,0.7)",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",pointerEvents:"none",userSelect:"none"}}>{f.name}</span>
                  {/* Resize handle */}
                  <div onPointerDown={(e)=>{e.stopPropagation();e.preventDefault();const rect=overlayRef.current.getBoundingClientRect();setResizing({idx:realIdx,startX:e.clientX-rect.left,startY:e.clientY-rect.top,origW:f.w,origH:f.h});}}
                    style={{position:"absolute",right:-3,bottom:-3,width:12,height:12,background:"rgba(232,116,42,0.6)",borderRadius:"50%",cursor:"nwse-resize",touchAction:"none",border:"1px solid #fff"}}/>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Field list summary */}
      {fields.length>0&&(
        <div style={{padding:"12px 16px",borderTop:`1px solid ${C.brd}`}}>
          <div style={{fontSize:12,fontWeight:700,color:C.lt,marginBottom:8}}>Fields ({fields.length})</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {fields.map((f,i)=>(
              <span key={i} onClick={()=>{if(f.page!==pageNum)setPageNum(f.page);setModalName(f.name);setModalType(f.fieldType||"text");setModalMode(f.mode);setModal({...f,idx:i,isNew:false});}}
                style={{padding:"4px 10px",background:f.mode==="lock"?C.inp:f.mode==="auto-date"?"rgba(90,143,192,0.15)":"rgba(232,116,42,0.1)",border:`1px solid ${f.mode==="lock"?C.brd:f.mode==="auto-date"?C.blu:C.org}`,borderRadius:12,fontSize:11,color:f.mode==="lock"?C.mut:f.mode==="auto-date"?C.blu:C.org,fontWeight:600,cursor:"pointer"}}>
                {f.name}{f.page>1?` (p${f.page})`:""}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Field Editor Modal */}
      {modal&&(
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",zIndex:1000,display:"flex",alignItems:"flex-end",justifyContent:"center"}}
          onClick={()=>setModal(null)}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:420,background:C.card,borderRadius:"16px 16px 0 0",padding:"20px",paddingBottom:"calc(20px + env(safe-area-inset-bottom))"}}>
            <div style={{fontSize:16,fontWeight:700,color:C.txt,marginBottom:16}}>{modal.isNew?"Add Field":"Edit Field"}</div>

            {/* Field name */}
            <div style={{marginBottom:12}}>
              <label style={{fontSize:12,color:C.lt,fontWeight:600,display:"block",marginBottom:4}}>Field Name</label>
              <input type="text" value={modalName} onChange={e=>setModalName(e.target.value)}
                placeholder="e.g. Date, Weather, Notes..."
                autoFocus
                style={{width:"100%",padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:15,boxSizing:"border-box"}}/>
              {nearbyText&&modal.isNew&&modalName!==nearbyText&&(
                <button onClick={()=>setModalName(nearbyText)} style={{marginTop:4,padding:"3px 8px",background:"rgba(232,116,42,0.1)",border:`1px solid ${C.org}`,borderRadius:6,color:C.org,fontSize:11,cursor:"pointer"}}>
                  Use: "{nearbyText}"
                </button>
              )}
            </div>

            {/* Field type */}
            <div style={{marginBottom:12}}>
              <label style={{fontSize:12,color:C.lt,fontWeight:600,display:"block",marginBottom:6}}>Type</label>
              <div style={{display:"flex",gap:6}}>
                {[{k:"text",l:"Text"},{k:"textarea",l:"Notes"},{k:"signature",l:"Signature"}].map(t=>(
                  <button key={t.k} onClick={()=>{setModalType(t.k);if(t.k==="textarea")setFields(prev=>modal.isNew?prev:prev.map((f,i)=>i===modal.idx?{...f,h:Math.max(f.h,80)}:f));}}
                    style={{flex:1,padding:"8px 0",background:modalType===t.k?C.org:"transparent",border:`1px solid ${modalType===t.k?C.org:C.brd}`,borderRadius:8,color:modalType===t.k?"#fff":C.mut,fontSize:13,fontWeight:600,cursor:"pointer"}}>
                    {t.l}
                  </button>
                ))}
              </div>
            </div>

            {/* Mode */}
            <div style={{marginBottom:16}}>
              <label style={{fontSize:12,color:C.lt,fontWeight:600,display:"block",marginBottom:6}}>Behavior</label>
              <div style={{display:"flex",gap:6}}>
                {[{k:"edit",l:"Edit Daily",c:C.org},{k:"lock",l:"Lock",c:C.mut},{k:"auto-date",l:"Auto-Date",c:C.blu},{k:"auto-num",l:"Auto-#",c:C.blu}].map(m=>(
                  <button key={m.k} onClick={()=>setModalMode(m.k)}
                    style={{flex:1,padding:"7px 0",background:modalMode===m.k?m.c:"transparent",border:`1px solid ${modalMode===m.k?m.c:C.brd}`,borderRadius:8,color:modalMode===m.k?"#fff":C.mut,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                    {m.l}
                  </button>
                ))}
              </div>
              <div style={{fontSize:10,color:C.mut,marginTop:4}}>
                {modalMode==="edit"?"You fill this field each report":modalMode==="lock"?"Same value every report (set once)":modalMode==="auto-date"?"Auto-fills today's date":"Auto-increments (1, 2, 3...)"}
              </div>
            </div>

            {/* Actions */}
            <div style={{display:"flex",gap:10}}>
              {!modal.isNew&&(
                <button onClick={()=>deleteField(modal.idx)} style={{padding:"12px 16px",background:"transparent",border:`1px solid ${C.err}`,borderRadius:10,color:C.err,fontSize:14,fontWeight:700,cursor:"pointer"}}>Delete</button>
              )}
              <button onClick={()=>setModal(null)} style={{flex:1,padding:"12px 0",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:14,fontWeight:600,cursor:"pointer"}}>Cancel</button>
              <button onClick={saveField} disabled={!modalName.trim()} style={{flex:1,padding:"12px 0",background:modalName.trim()?C.org:C.brd,border:"none",borderRadius:10,color:"#fff",fontSize:14,fontWeight:700,cursor:modalName.trim()?"pointer":"default"}}>
                {modal.isNew?"Add":"Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TemplateFieldEditor;
