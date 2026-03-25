import { useState, useEffect, useRef, useCallback } from 'react';
import { C } from '../constants/theme';
import { ensurePdfJs } from '../utils/pdf';
import { extractPdfTextStructure } from '../utils/auth';

function TemplateFieldEditor({pdfBase64,initialFields,onDone,onCancel}){
  const containerRef=useRef(null);
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
  const [selected,setSelected]=useState(null); // index of selected field (for highlight + toolbar)
  const [dragging,setDragging]=useState(null); // {idx,startX,startY,origX,origY}
  const [resizing,setResizing]=useState(null); // {idx,startX,startY,origW,origH}
  const [didDrag,setDidDrag]=useState(false); // track if pointer moved during drag
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
        try{
          const items=await extractPdfTextStructure(u8);
          setTextItems(items);
        }catch(e){console.error("Text extraction for suggestions:",e);}
      }catch(e){console.error("PDF load error:",e);}
      finally{setLoading(false);}
    })();
  },[pdfBase64]);

  // Render current page — handles rotation, high-DPI, and responsive sizing
  useEffect(()=>{
    if(!pdfDoc||!canvasRef.current)return;
    (async()=>{
      const page=await pdfDoc.getPage(pageNum);
      const vp=page.getViewport({scale:1,rotation:page.rotate||0});
      // Responsive: use container width, capped at 800px for desktop
      const container=containerRef.current;
      const containerW=container?container.clientWidth:800;
      const maxW=Math.min(containerW-32,800);
      const s=maxW/vp.width;
      setScale(s);setPageW(vp.width);setPageH(vp.height);
      const svp=page.getViewport({scale:s,rotation:page.rotate||0});
      const cvs=canvasRef.current;
      const dpr=window.devicePixelRatio||1;
      cvs.width=Math.round(svp.width*dpr);
      cvs.height=Math.round(svp.height*dpr);
      cvs.style.width=Math.round(svp.width)+"px";
      cvs.style.height=Math.round(svp.height)+"px";
      const ctx=cvs.getContext("2d");
      ctx.scale(dpr,dpr);
      await page.render({canvasContext:ctx,viewport:svp}).promise;
    })();
  },[pdfDoc,pageNum]);

  // Re-render on window resize for responsive desktop
  useEffect(()=>{
    const handleResize=()=>{
      if(pdfDoc&&canvasRef.current){
        // Force re-render by toggling page
        setPageNum(p=>p);
      }
    };
    window.addEventListener("resize",handleResize);
    return()=>window.removeEventListener("resize",handleResize);
  },[pdfDoc]);

  // Find nearby text for auto-suggest field name
  const findNearbyText=(clickX,clickY,pg)=>{
    let best="";let bestDist=Infinity;
    textItems.filter(t=>t.page===pg).forEach(t=>{
      const cx=t.x+t.w/2;const cy=t.y+t.h/2;
      const dist=Math.sqrt((cx-clickX)**2+(cy-clickY)**2);
      if(dist<bestDist&&dist<80){bestDist=dist;best=t.str;}
    });
    return best;
  };

  // Handle tap on empty area of overlay to place a new field
  const handleOverlayClick=(e)=>{
    if(dragging||resizing||didDrag)return;
    const rect=overlayRef.current.getBoundingClientRect();
    const px=e.clientX-rect.left;
    const py=e.clientY-rect.top;
    const pdfX=px/scale;
    const pdfY=py/scale;
    const defW=120,defH=18;
    const nearby=findNearbyText(pdfX,pdfY,pageNum);
    let suggestion=nearby.replace(/[:_\-\.]+$/,"").trim();
    if(suggestion.length>30||/^\d+$/.test(suggestion))suggestion="";
    setNearbyText(suggestion);
    setModalName(suggestion);
    setModalType(suggestion.toLowerCase().includes("note")||suggestion.toLowerCase().includes("comment")?"textarea":"text");
    setModalMode(suggestion.toLowerCase().includes("date")?"auto-date":"edit");
    setModal({x:pdfX,y:pdfY,w:defW,h:defH,page:pageNum,isNew:true});
    setSelected(null);
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
      w:snap(Math.round((modal.w||120)*100)/100),
      h:snap(Math.round((modal.h||(modalType==="textarea"?60:18))*100)/100),
      fontSize:modalType==="textarea"?10:12,
      multiline:modalType==="textarea",
      voiceEnabled:modalType!=="signature",
      fieldType:modalType
    };
    if(modal.isNew){
      setFields(prev=>[...prev,entry]);
      setSelected(fields.length); // select the newly added field
    }else{
      setFields(prev=>prev.map((f,i)=>i===modal.idx?{...f,...entry}:f));
      setSelected(modal.idx);
    }
    setModal(null);setModalName("");
  };

  // Delete field
  const deleteField=(idx)=>{
    setFields(prev=>prev.filter((_,i)=>i!==idx));
    setModal(null);
    setSelected(null);
  };

  // Field drag handler — pointerDown on a field starts drag
  const startDrag=(e,idx)=>{
    e.stopPropagation();e.preventDefault();
    setDidDrag(false);
    const rect=overlayRef.current.getBoundingClientRect();
    setDragging({idx,startX:e.clientX-rect.left,startY:e.clientY-rect.top,origX:fields[idx].x,origY:fields[idx].y});
    setSelected(idx);
  };

  const onPointerMove=(e)=>{
    if(!overlayRef.current)return;
    const rect=overlayRef.current.getBoundingClientRect();
    const px=e.clientX-rect.left;const py=e.clientY-rect.top;
    if(dragging){
      const dx=(px-dragging.startX)/scale;
      const dy=(py-dragging.startY)/scale;
      if(Math.abs(dx)>2||Math.abs(dy)>2)setDidDrag(true);
      setFields(prev=>prev.map((f,i)=>i===dragging.idx?{...f,x:snap(Math.max(0,dragging.origX+dx)),y:snap(Math.max(0,dragging.origY+dy))}:f));
    }
    if(resizing){
      const dx=(px-resizing.startX)/scale;
      const dy=(py-resizing.startY)/scale;
      setDidDrag(true);
      setFields(prev=>prev.map((f,i)=>i===resizing.idx?{...f,w:snap(Math.max(40,resizing.origW+dx)),h:snap(Math.max(16,resizing.origH+dy))}:f));
    }
  };

  const onPointerUp=()=>{
    setDragging(null);setResizing(null);
    // Reset didDrag after a tick so the click handler can check it
    setTimeout(()=>setDidDrag(false),50);
  };

  // Snap to 4px grid in PDF pts
  const snap=(v)=>Math.round(v/4)*4;

  // Open edit modal for a field
  const openFieldModal=(idx)=>{
    const f=fields[idx];
    setModalName(f.name);
    setModalType(f.fieldType||"text");
    setModalMode(f.mode);
    setModal({...f,idx,isNew:false});
  };

  const pageFields=fields.filter(f=>f.page===pageNum);

  if(loading)return(
    <div style={{padding:40,textAlign:"center"}}>
      <div style={{width:36,height:36,border:`3px solid ${C.brd}`,borderTop:`3px solid ${C.org}`,borderRadius:"50%",margin:"0 auto 12px",animation:"spin 1s linear infinite"}}/>
      <p style={{color:C.mut,fontSize:14}}>Loading template preview...</p>
    </div>
  );

  return(
    <div ref={containerRef} style={{background:C.bg,color:C.txt,minHeight:"100vh"}}>
      {/* Header */}
      <div style={{maxWidth:900,margin:"0 auto",padding:"16px 20px",borderBottom:`1px solid ${C.brd}`,background:C.card,display:"flex",alignItems:"center",gap:12}}>
        <button onClick={onCancel} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:24,cursor:"pointer",lineHeight:1,width:48,height:48,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <div style={{flex:1}}>
          <div style={{fontWeight:700,fontSize:17}}>Place Fields</div>
          <div style={{fontSize:12,color:C.mut}}>Click anywhere to add a field — drag to move — double-click to edit</div>
        </div>
        <div style={{fontSize:13,color:C.lt,fontWeight:600,background:C.inp,borderRadius:10,padding:"4px 12px"}}>{fields.length} field{fields.length!==1?"s":""}</div>
        <button onClick={()=>onDone(fields)} disabled={fields.length===0} style={{padding:"10px 20px",background:fields.length?C.org:C.brd,border:"none",borderRadius:10,color:"#fff",fontSize:14,fontWeight:700,cursor:fields.length?"pointer":"default",opacity:fields.length?1:0.5}}>Done</button>
      </div>

      {/* Quick preset buttons */}
      <div style={{maxWidth:900,margin:"0 auto",padding:"10px 20px",display:"flex",gap:8,flexWrap:"wrap",borderBottom:`1px solid ${C.brd}`}}>
        {FIELD_PRESETS.map(p=>(
          <button key={p} onClick={()=>{setModalName(p);setModalType(p==="Notes"?"textarea":p==="Signature"?"signature":"text");setModalMode(p==="Date"?"auto-date":["Project Name","Project No","Inspector"].includes(p)?"lock":"edit");setModal({x:pageW/2-60,y:pageH/2-9,w:120,h:p==="Notes"?60:p==="Signature"?28:18,page:pageNum,isNew:true});}}
            style={{padding:"8px 16px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:20,color:C.lt,fontSize:13,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>
            + {p}
          </button>
        ))}
      </div>

      {/* Page navigation */}
      {numPages>1&&(
        <div style={{maxWidth:900,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"center",gap:16,padding:"10px 0",borderBottom:`1px solid ${C.brd}`}}>
          <button onClick={()=>setPageNum(p=>Math.max(1,p-1))} disabled={pageNum<=1} style={{background:"none",border:"none",color:pageNum>1?C.blu:C.brd,fontSize:22,cursor:pageNum>1?"pointer":"default",padding:"4px 12px"}}>‹</button>
          <span style={{fontSize:14,color:C.lt,fontWeight:600}}>Page {pageNum} of {numPages}</span>
          <button onClick={()=>setPageNum(p=>Math.min(numPages,p+1))} disabled={pageNum>=numPages} style={{background:"none",border:"none",color:pageNum<numPages?C.blu:C.brd,fontSize:22,cursor:pageNum<numPages?"pointer":"default",padding:"4px 12px"}}>›</button>
        </div>
      )}

      {/* Main content area — centered, padded for desktop */}
      <div style={{maxWidth:900,margin:"0 auto",padding:"20px",display:"flex",flexDirection:"column",alignItems:"center"}}>
        {/* Canvas + overlay */}
        <div style={{position:"relative",display:"inline-block",boxShadow:"0 4px 24px rgba(0,0,0,0.4)",borderRadius:6,overflow:"hidden",cursor:"crosshair"}}>
          <canvas ref={canvasRef} style={{display:"block"}}/>
          {/* Clickable overlay */}
          <div ref={overlayRef}
            onClick={handleOverlayClick}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",touchAction:"none"}}>
            {/* Rendered field boxes */}
            {pageFields.map((f,i)=>{
              const realIdx=fields.indexOf(f);
              const isSel=selected===realIdx;
              const isActive=modal&&!modal.isNew&&modal.idx===realIdx;
              return(
                <div key={realIdx}
                  onPointerDown={(e)=>startDrag(e,realIdx)}
                  onDoubleClick={(e)=>{e.stopPropagation();openFieldModal(realIdx);}}
                  onClick={(e)=>{e.stopPropagation();if(!didDrag)setSelected(realIdx);}}
                  style={{position:"absolute",left:f.x*scale,top:f.y*scale,width:f.w*scale,height:f.h*scale,
                    background:isSel||isActive?"rgba(232,116,42,0.15)":"rgba(232,116,42,0.06)",
                    border:isSel||isActive?`2px solid ${C.org}`:"1px dashed rgba(232,116,42,0.5)",
                    borderRadius:3,cursor:"move",touchAction:"none",
                    boxSizing:"border-box",transition:"border 0.15s, background 0.15s"}}>
                  {/* Field name label — positioned above the box */}
                  <div style={{position:"absolute",top:-18,left:0,fontSize:10,color:isSel?C.org:"rgba(232,116,42,0.8)",fontWeight:700,whiteSpace:"nowrap",pointerEvents:"none",userSelect:"none",textShadow:"0 1px 3px rgba(0,0,0,0.6)",letterSpacing:0.3}}>{f.name}</div>
                  {/* Selected field toolbar */}
                  {isSel&&(
                    <div style={{position:"absolute",top:-32,right:0,display:"flex",gap:4,zIndex:10}} onClick={e=>e.stopPropagation()}>
                      <button onClick={(e)=>{e.stopPropagation();openFieldModal(realIdx);}} style={{width:24,height:24,borderRadius:6,background:C.org,border:"none",color:"#fff",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}} title="Edit field">✎</button>
                      <button onClick={(e)=>{e.stopPropagation();deleteField(realIdx);}} style={{width:24,height:24,borderRadius:6,background:C.err||"#ef4444",border:"none",color:"#fff",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}} title="Delete field">✕</button>
                    </div>
                  )}
                  {/* Resize handle */}
                  <div onPointerDown={(e)=>{e.stopPropagation();e.preventDefault();setDidDrag(false);const rect=overlayRef.current.getBoundingClientRect();setResizing({idx:realIdx,startX:e.clientX-rect.left,startY:e.clientY-rect.top,origW:f.w,origH:f.h});setSelected(realIdx);}}
                    style={{position:"absolute",right:-4,bottom:-4,width:14,height:14,background:isSel?"rgba(232,116,42,0.9)":"rgba(232,116,42,0.5)",borderRadius:"50%",cursor:"nwse-resize",touchAction:"none",border:"2px solid #fff",boxSizing:"border-box"}}/>
                </div>
              );
            })}
          </div>
        </div>

        {/* Instruction hint */}
        <div style={{marginTop:12,fontSize:12,color:C.mut,textAlign:"center"}}>
          Click empty area = add field — Drag field = move — Double-click field = edit — Use handles to resize
        </div>
      </div>

      {/* Field list summary */}
      {fields.length>0&&(
        <div style={{maxWidth:900,margin:"0 auto",padding:"16px 20px",borderTop:`1px solid ${C.brd}`}}>
          <div style={{fontSize:13,fontWeight:700,color:C.lt,marginBottom:10}}>Fields ({fields.length})</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {fields.map((f,i)=>(
              <span key={i} onClick={()=>{if(f.page!==pageNum)setPageNum(f.page);setSelected(i);}}
                style={{padding:"6px 14px",background:selected===i?"rgba(232,116,42,0.2)":f.mode==="lock"?C.inp:f.mode==="auto-date"?"rgba(90,143,192,0.15)":"rgba(232,116,42,0.1)",border:`1px solid ${selected===i?C.org:f.mode==="lock"?C.brd:f.mode==="auto-date"?C.blu:C.org}`,borderRadius:14,fontSize:12,color:selected===i?C.org:f.mode==="lock"?C.mut:f.mode==="auto-date"?C.blu:C.org,fontWeight:600,cursor:"pointer",transition:"all 0.15s"}}>
                {f.name}{f.page>1?` (p${f.page})`:""}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Field Editor Modal */}
      {modal&&(
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={()=>setModal(null)}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:460,background:C.card,borderRadius:16,padding:"24px",margin:"20px",boxShadow:"0 8px 40px rgba(0,0,0,0.5)"}}>
            <div style={{fontSize:18,fontWeight:700,color:C.txt,marginBottom:20}}>{modal.isNew?"Add Field":"Edit Field"}</div>

            {/* Field name */}
            <div style={{marginBottom:14}}>
              <label style={{fontSize:13,color:C.lt,fontWeight:600,display:"block",marginBottom:6}}>Field Name</label>
              <input type="text" value={modalName} onChange={e=>setModalName(e.target.value)}
                placeholder="e.g. Date, Weather, Notes..."
                autoFocus
                style={{width:"100%",padding:"12px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:16,boxSizing:"border-box"}}/>
              {nearbyText&&modal.isNew&&modalName!==nearbyText&&(
                <button onClick={()=>setModalName(nearbyText)} style={{marginTop:6,padding:"4px 10px",background:"rgba(232,116,42,0.1)",border:`1px solid ${C.org}`,borderRadius:8,color:C.org,fontSize:12,cursor:"pointer"}}>
                  Use: "{nearbyText}"
                </button>
              )}
            </div>

            {/* Field type */}
            <div style={{marginBottom:14}}>
              <label style={{fontSize:13,color:C.lt,fontWeight:600,display:"block",marginBottom:6}}>Type</label>
              <div style={{display:"flex",gap:8}}>
                {[{k:"text",l:"Text"},{k:"textarea",l:"Notes"},{k:"signature",l:"Signature"}].map(t=>(
                  <button key={t.k} onClick={()=>{setModalType(t.k);if(t.k==="textarea")setFields(prev=>modal.isNew?prev:prev.map((f,i)=>i===modal.idx?{...f,h:Math.max(f.h,80)}:f));}}
                    style={{flex:1,padding:"10px 0",background:modalType===t.k?C.org:"transparent",border:`1px solid ${modalType===t.k?C.org:C.brd}`,borderRadius:10,color:modalType===t.k?"#fff":C.mut,fontSize:14,fontWeight:600,cursor:"pointer"}}>
                    {t.l}
                  </button>
                ))}
              </div>
            </div>

            {/* Mode */}
            <div style={{marginBottom:20}}>
              <label style={{fontSize:13,color:C.lt,fontWeight:600,display:"block",marginBottom:6}}>Behavior</label>
              <div style={{display:"flex",gap:6}}>
                {[{k:"edit",l:"Edit Daily",c:C.org},{k:"lock",l:"Lock",c:C.mut},{k:"auto-date",l:"Auto-Date",c:C.blu},{k:"auto-num",l:"Auto-#",c:C.blu}].map(m=>(
                  <button key={m.k} onClick={()=>setModalMode(m.k)}
                    style={{flex:1,padding:"9px 0",background:modalMode===m.k?m.c:"transparent",border:`1px solid ${modalMode===m.k?m.c:C.brd}`,borderRadius:10,color:modalMode===m.k?"#fff":C.mut,fontSize:12,fontWeight:700,cursor:"pointer"}}>
                    {m.l}
                  </button>
                ))}
              </div>
              <div style={{fontSize:11,color:C.mut,marginTop:6}}>
                {modalMode==="edit"?"You fill this field each report":modalMode==="lock"?"Same value every report (set once)":modalMode==="auto-date"?"Auto-fills today's date":"Auto-increments (1, 2, 3...)"}
              </div>
            </div>

            {/* Actions */}
            <div style={{display:"flex",gap:10}}>
              {!modal.isNew&&(
                <button onClick={()=>deleteField(modal.idx)} style={{padding:"12px 18px",background:"transparent",border:`1px solid ${C.err||"#ef4444"}`,borderRadius:10,color:C.err||"#ef4444",fontSize:14,fontWeight:700,cursor:"pointer"}}>Delete</button>
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
