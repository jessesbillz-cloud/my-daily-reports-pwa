import { useState, useEffect, useRef, useMemo } from 'react';
import { C } from '../constants/theme';
import { getAuthToken } from '../utils/auth';
import { SB_URL, SB_KEY } from '../constants/supabase';

function SupportChat({user}){
  // Robust token getter: live AUTH_TOKEN → mdr_session stored token → null (fail explicitly)
  const getTok=()=>{
    const live=getAuthToken();
    if(live)return live;
    try{const s=JSON.parse(localStorage.getItem("mdr_session")||"{}");if(s.access_token)return s.access_token;}catch(e){}
    return null;
  };
  const [scToast,setScToast]=useState("");
  const showToast=(m)=>{setScToast(m);setTimeout(()=>setScToast(""),3000);};
  const [open,setOpen]=useState(false);
  const savedConvId=useMemo(()=>{try{return localStorage.getItem("mdr_support_conv")||null;}catch(e){return null;}},[]);
  const [convId,setConvId]=useState(savedConvId);
  const [msgs,setMsgs]=useState([]);
  const [draft,setDraft]=useState("");
  const [guestName,setGuestName]=useState("");
  const [guestEmail,setGuestEmail]=useState("");
  const [sending,setSending]=useState(false);
  const [started,setStarted]=useState(!!savedConvId);
  const scrollRef=useRef(null);
  const subRef=useRef(null);

  // Resume existing conversation on open
  useEffect(()=>{
    if(open&&convId&&started){
      // Verify conversation still exists, then load messages
      const tok=getTok();
      if(!tok){console.warn("No auth token to load messages");return;}
      (async()=>{
        try{
          // Check conversation still exists
          const cv=await fetch(`${SB_URL}/rest/v1/support_conversations?id=eq.${convId}&select=id`,{headers:{"apikey":SB_KEY,"Authorization":"Bearer "+tok}});
          if(cv.ok){const arr=await cv.json();if(!arr||arr.length===0){setConvId(null);setStarted(false);setMsgs([]);try{localStorage.removeItem("mdr_support_conv");}catch(e){}return;}}
          const r=await fetch(`${SB_URL}/rest/v1/support_messages?conversation_id=eq.${convId}&order=created_at.asc`,{headers:{"apikey":SB_KEY,"Authorization":"Bearer "+tok}});
          if(r.ok)setMsgs(await r.json());
        }catch(e){}
      })();
      subscribeToMessages(convId);
    }
    return()=>{if(!open&&subRef.current)subRef.current.unsubscribe?.();};
  },[open]);

  // Start or resume conversation
  const startChat=async()=>{
    const tok=getTok();
    if(!tok){showToast("Please sign in to use chat");return;}
    const headers={"apikey":SB_KEY,"Content-Type":"application/json","Authorization":"Bearer "+tok,"Prefer":"return=representation"};
    try{
      // Create new conversation
      const body={status:"open"};
      if(user)body.user_id=user.id;
      if(guestName.trim())body.guest_name=guestName.trim();
      if(guestEmail.trim())body.guest_email=guestEmail.trim();
      if(user&&user.user_metadata?.full_name)body.guest_name=user.user_metadata.full_name;
      if(user&&user.email)body.guest_email=user.email;
      const r=await fetch(`${SB_URL}/rest/v1/support_conversations`,{method:"POST",headers,body:JSON.stringify(body)});
      const txt=await r.text();
      if(!r.ok){showToast("Chat error — try again");return;}
      const convArr=JSON.parse(txt);
      if(!convArr||!convArr[0]){showToast("Chat error — try again");return;}
      setConvId(convArr[0].id);
      setStarted(true);
      try{localStorage.setItem("mdr_support_conv",convArr[0].id);}catch(e){}
      subscribeToMessages(convArr[0].id);
    }catch(e){showToast("Chat error — try again");}
  };

  const subscribeToMessages=(cid)=>{
    if(subRef.current)subRef.current.unsubscribe?.();
    // Poll for new messages every 3s (simpler than realtime for PWA)
    const tok=getTok();
    if(!tok){console.warn("No auth token to subscribe");return;}
    const h={"apikey":SB_KEY,"Authorization":"Bearer "+tok};
    const poll=setInterval(async()=>{
      try{
        const r=await fetch(`${SB_URL}/rest/v1/support_messages?conversation_id=eq.${cid}&order=created_at.asc`,{headers:h});
        if(r.ok){const newMsgs=await r.json();setMsgs(newMsgs);}
      }catch(e){}
    },3000);
    subRef.current={unsubscribe:()=>clearInterval(poll)};
  };

  useEffect(()=>{return()=>{if(subRef.current)subRef.current.unsubscribe?.();};},[]);
  useEffect(()=>{if(scrollRef.current)scrollRef.current.scrollTop=scrollRef.current.scrollHeight;},[msgs]);

  const sendMsg=async()=>{
    if(!draft.trim()||sending||!convId)return;
    const msgText=draft.trim();
    setSending(true);
    // Optimistic: show the message immediately in the UI
    const tempMsg={id:"tmp-"+Date.now(),conversation_id:convId,sender:"user",body:msgText,created_at:new Date().toISOString()};
    setMsgs(prev=>[...prev,tempMsg]);
    setDraft("");
    try{
      const tok=getTok();
      if(!tok){showToast("Not authenticated");setMsgs(prev=>prev.filter(m=>m.id!==tempMsg.id));setDraft(msgText);setSending(false);return;}
      const h={"apikey":SB_KEY,"Authorization":"Bearer "+tok,"Content-Type":"application/json"};
      const pr=await fetch(`${SB_URL}/rest/v1/support_messages`,{method:"POST",headers:h,body:JSON.stringify({conversation_id:convId,sender:"user",body:msgText})});
      if(!pr.ok){showToast("Send failed — try again");setMsgs(prev=>prev.filter(m=>m.id!==tempMsg.id));setDraft(msgText);setSending(false);return;}
      // Reload from server to get real IDs (polling will also handle this)
      const r=await fetch(`${SB_URL}/rest/v1/support_messages?conversation_id=eq.${convId}&order=created_at.asc`,{headers:{"apikey":SB_KEY,"Authorization":"Bearer "+tok}});
      if(r.ok){const real=await r.json();if(real.length>0)setMsgs(real);}
      // If server read fails (RLS), keep the optimistic message — user still sees their text
    }catch(e){showToast("Send failed — try again");setMsgs(prev=>prev.filter(m=>m.id!==tempMsg.id));setDraft(msgText);}
    finally{setSending(false);}
  };

  if(!open)return(
    <button onClick={()=>setOpen(true)} style={{position:"fixed",bottom:20,right:20,width:56,height:56,borderRadius:"50%",background:C.org,border:"none",color:"#fff",fontSize:24,cursor:"pointer",zIndex:9999,boxShadow:"0 4px 12px rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center"}}>
      💬
    </button>
  );

  return(
    <div style={{position:"fixed",bottom:20,right:20,width:340,maxWidth:"calc(100vw - 40px)",height:460,maxHeight:"calc(100vh - 40px)",background:C.card,border:`1px solid ${C.brd}`,borderRadius:16,zIndex:9999,display:"flex",flexDirection:"column",boxShadow:"0 8px 32px rgba(0,0,0,0.5)",overflow:"hidden"}}>
      {scToast&&<div style={{position:"absolute",top:50,left:"50%",transform:"translateX(-50%)",background:"#333",color:"#fff",padding:"8px 16px",borderRadius:8,fontSize:13,zIndex:10,whiteSpace:"nowrap"}}>{scToast}</div>}
      {/* Header */}
      <div style={{padding:"14px 16px",background:C.org,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{color:"#fff",fontWeight:700,fontSize:15}}>Support Chat</div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {started&&<button onClick={()=>{setConvId(null);setMsgs([]);setStarted(false);if(subRef.current)subRef.current.unsubscribe?.();try{localStorage.removeItem("mdr_support_conv");}catch(e){}}} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",padding:"4px 10px",borderRadius:6}}>New Chat</button>}
          <button onClick={()=>setOpen(false)} style={{background:"none",border:"none",color:"#fff",fontSize:20,cursor:"pointer",lineHeight:1}}>×</button>
        </div>
      </div>

      {!started?(
        <div style={{flex:1,padding:20,display:"flex",flexDirection:"column",gap:12}}>
          <div style={{fontSize:14,color:C.lt,lineHeight:1.5}}>Have a question or found a bug? Chat with our support team.</div>
          {!user&&(
            <>
              <input type="text" placeholder="Your name (optional)" value={guestName} onChange={e=>setGuestName(e.target.value)} style={{padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:13}}/>
              <input type="email" placeholder="Your email (optional)" value={guestEmail} onChange={e=>setGuestEmail(e.target.value)} style={{padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:13}}/>
            </>
          )}
          {user&&<div style={{fontSize:12,color:C.mut}}>Chatting as {user.user_metadata?.full_name||user.email}</div>}
          <button onClick={startChat} style={{padding:"14px 0",background:C.org,border:"none",borderRadius:10,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer",marginTop:"auto"}}>Start Chat</button>
        </div>
      ):(
        <>
          {/* Messages */}
          <div ref={scrollRef} style={{flex:1,overflowY:"auto",padding:12,display:"flex",flexDirection:"column",gap:8}}>
            {msgs.length===0&&<div style={{textAlign:"center",color:C.mut,fontSize:13,marginTop:20}}>Send a message to get started</div>}
            {msgs.map(m=>(
              <div key={m.id} style={{alignSelf:m.sender==="user"?"flex-end":"flex-start",maxWidth:"80%"}}>
                <div style={{padding:"8px 12px",borderRadius:12,background:m.sender==="user"?C.org:"#333",color:"#fff",fontSize:13,lineHeight:1.5,borderBottomRightRadius:m.sender==="user"?4:12,borderBottomLeftRadius:m.sender==="agent"?4:12}}>
                  {m.body}
                </div>
                <div style={{fontSize:10,color:C.mut,marginTop:2,textAlign:m.sender==="user"?"right":"left"}}>{new Date(m.created_at).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</div>
              </div>
            ))}
          </div>
          {/* Input */}
          <div style={{padding:10,borderTop:`1px solid ${C.brd}`,display:"flex",gap:8}}>
            <input type="text" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey)sendMsg();}} placeholder="Type a message..." style={{flex:1,padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:13}}/>
            <button onClick={sendMsg} disabled={sending||!draft.trim()} style={{padding:"10px 16px",background:C.org,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:sending?"default":"pointer",opacity:sending||!draft.trim()?0.5:1}}>→</button>
          </div>
        </>
      )}
    </div>
  );
}

export default SupportChat;
