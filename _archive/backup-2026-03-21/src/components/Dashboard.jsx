import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { C, SL } from '../constants/theme';
import { db } from '../utils/db';
import { AUTH_TOKEN, getAuthToken, refreshAuthToken, authLogout } from '../utils/auth';
import { SB_URL, SB_KEY } from '../constants/supabase';
import { api } from '../utils/api';
import JobDetail from './JobDetail';
import AccountSettings from './AccountSettings';
import CreateJob from './CreateJob';
import ArchivedJobs from './ArchivedJobs';
import TrainingCenter from './TrainingCenter';
import SupportChat from './SupportChat';
import { askConfirm } from './ConfirmOverlay';
import MDRLogo from './MDRLogo';

function Dashboard({user, onLogout}){
  const [dashToast,setDashToast]=useState("");
  const showToast=(m)=>{setDashToast(m);setTimeout(()=>setDashToast(""),3000);};
  const [jobs,setJobs]=useState([]);
  const [rpts,setRpts]=useState([]);
  const [loading,setLoading]=useState(true);
  const [selJob,setSelJob]=useState(null);
  const [showSet,setShowSet]=useState(false);
  const [showNew,setShowNew]=useState(false);
  const [showDD,setShowDD]=useState(false);
  const [showArch,setShowArch]=useState(false);
  const [showAcct,setShowAcct]=useState(false);
  const [showTrain,setShowTrain]=useState(false);
  const [showFairUse,setShowFairUse]=useState(false);
  const [showTos,setShowTos]=useState(false);
  const [showPriv,setShowPriv]=useState(false);
  const [profileSlug,setProfileSlug]=useState("");
  const [calendarToken,setCalendarToken]=useState("");
  const [calRequests,setCalRequests]=useState([]);
  const [selCalDay,setSelCalDay]=useState(null);
  const [calYear,setCalYear]=useState(new Date().getFullYear());
  const [calMonth,setCalMonth]=useState(new Date().getMonth());
  const [editReq,setEditReq]=useState(null);
  const [editReqDate,setEditReqDate]=useState("");
  const [showBlockTime,setShowBlockTime]=useState(false);
  const [blockTimeStart,setBlockTimeStart]=useState("08:00");
  const [blockTimeEnd,setBlockTimeEnd]=useState("09:00");
  // Note: time slot range is 5AM-5PM
  const [blockTimeNote,setBlockTimeNote]=useState("");
  const [blockTimeSaving,setBlockTimeSaving]=useState(false);
  const [blockTimeRepeat,setBlockTimeRepeat]=useState(false);
  const [editReqTime,setEditReqTime]=useState("");
  const [editReqSaving,setEditReqSaving]=useState(false);
  const [showSubDash,setShowSubDash]=useState(false);
  const [shareCopied,setShareCopied]=useState(false);
  const [navRestored,setNavRestored]=useState(false);
  const [dashLogoUrl,setDashLogoUrl]=useState(null);
  const [subStatus,setSubStatus]=useState("loading"); // loading, trialing, active, expired, past_due, cancelled, trial_abused
  const [trialEndsAt,setTrialEndsAt]=useState(null);
  const [subPlan,setSubPlan]=useState("");
  const [showPaywall,setShowPaywall]=useState(false);

  // Persist navigation state — saves selected job ID so user returns to where they were
  const saveNav=(jobId)=>{try{localStorage.setItem("mdr_nav",JSON.stringify({jobId:jobId||null,ts:Date.now()}));}catch(e){}};
  // When selJob changes, persist it
  useEffect(()=>{if(navRestored)saveNav(selJob?.id||null);},[selJob,navRestored]);

  useEffect(()=>{load();},[]);
  useEffect(()=>{loadRequests();},[calYear,calMonth]);
  const loadRequests=async()=>{
    try{
      const start=`${calYear}-${String(calMonth+1).padStart(2,"0")}-01`;
      const lastD=new Date(calYear,calMonth+1,0).getDate();
      const end=`${calYear}-${String(calMonth+1).padStart(2,"0")}-${String(lastD).padStart(2,"0")}`;
      const reqs=await db.getRequests(user.id,start,end);
      setCalRequests(reqs);
    }catch(e){console.error(e);}
  };
  // Quick refresh — only update report statuses (used on back navigation to avoid full reload)
  const refreshStatuses=async()=>{try{const ids=jobs.filter(j=>!j.is_archived).map(j=>j.id);if(ids.length)setRpts(await db.todayRpts(ids));}catch(e){}};
  const load=async()=>{setLoading(true);try{
    // Fire jobs + profile in parallel
    const [rawJobs, p]=await Promise.all([db.jobs(user.id), db.getProfile(user.id)]);
    // Normalize is_archived to strict boolean — guards against string "false" from Supabase
    const a=rawJobs.map(j=>({...j, is_archived: j.is_archived === true || j.is_archived === 'true' || j.is_archived === 't'}));
    setJobs(a);
    // Fetch today's report statuses (depends on jobs)
    const ids=a.filter(j=>!j.is_archived).map(j=>j.id);
    if(ids.length)setRpts(await db.todayRpts(ids));
    // Process profile
    if(p?.slug)setProfileSlug(p.slug);
    if(p?.calendar_token)setCalendarToken(p.calendar_token);
    if(p?.company_id){db.getCompanyLogoUrl(p.company_id).then(url=>{if(url)setDashLogoUrl(url);}).catch(()=>{});}
    // Check subscription status
    if(p){
      const ss=p.subscription_status||"trialing";
      setSubStatus(ss);
      setSubPlan(p.subscription_plan||"");
      if(p.trial_ends_at)setTrialEndsAt(new Date(p.trial_ends_at));
      if(ss==="trialing"&&p.trial_ends_at&&new Date(p.trial_ends_at)<new Date()){
        setSubStatus("expired");
      }
    }
    // Restore navigation state
    if(!navRestored){setNavRestored(true);try{const raw=localStorage.getItem("mdr_nav");if(raw){const nav=JSON.parse(raw);if(nav.jobId&&(Date.now()-nav.ts)<24*60*60*1000){const match=a.find(j=>j.id===nav.jobId);if(match)setSelJob(match);}}}catch(e){}}
  }catch(e){console.error(e);}finally{setLoading(false);}};
  const act=jobs.filter(j=>!j.is_archived);
  const arch=jobs.filter(j=>j.is_archived);
  // Sort active jobs by recent visit (tracked in localStorage)
  const getRecentJobIds=()=>{try{return JSON.parse(localStorage.getItem("mdr_recent_jobs")||"[]");}catch(e){return[];}};
  const trackJobVisit=(jobId)=>{try{let recent=getRecentJobIds().filter(id=>id!==jobId);recent.unshift(jobId);localStorage.setItem("mdr_recent_jobs",JSON.stringify(recent.slice(0,20)));}catch(e){}};
  const recentIds=getRecentJobIds();
  const sortedAct=[...act].sort((a,b)=>{const ai=recentIds.indexOf(a.id);const bi=recentIds.indexOf(b.id);if(ai===-1&&bi===-1)return 0;if(ai===-1)return 1;if(bi===-1)return -1;return ai-bi;});
  const visibleJobs=sortedAct.slice(0,4);
  const top3=act.slice(0,3);
  const stat=(id,sc)=>{if(sc==="as_needed")return"none";const r=rpts.find(r=>r.job_id===id);if(!r)return"due";return r.status==="submitted"?"submitted":"working";};
  const dot=(s)=>{if(s==="none")return null;const c=s==="submitted"?C.ok:s==="working"?C.org:"#ef4444";return<div style={{width:10,height:10,borderRadius:"50%",background:c,flexShrink:0}}/>;};

  const doShare=async()=>{const url=window.location.href;if(navigator.share){try{await navigator.share({title:"My Daily Reports",text:"Voice-to-PDF jobsite reports",url});}catch(e){}}else{try{await navigator.clipboard.writeText(url);showToast("Link copied!");}catch(e){showToast("Couldn't copy link");}}};

  // selectJob must be defined BEFORE any early returns that reference it (e.g. ArchivedJobs onSelect)
  const selectJob=(j)=>{if(j)trackJobVisit(j.id);setSelJob(j);};

  if(showAcct)return<AccountSettings user={user} onBack={()=>{setShowAcct(false);/* refresh logo in case it changed */db.getProfile(user.id).then(async p=>{if(p?.company_id){const l=await db.getCompanyLogoUrl(p.company_id);setDashLogoUrl(l||null);}}).catch(()=>{});}} onLogout={onLogout}/>;
  if(showNew)return<CreateJob user={user} onBack={()=>setShowNew(false)} onCreated={()=>{setShowNew(false);load();}}/>;
  if(showArch)return<ArchivedJobs jobs={arch} onBack={()=>setShowArch(false)} onSelect={(j)=>{selectJob(j);setShowArch(false);}}/>;
  if(showTrain)return<TrainingCenter onBack={()=>setShowTrain(false)}/>;
  if(showFairUse)return(
    <div style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 16px",borderBottom:`1px solid ${C.brd}`,background:C.card}}>
        <button onClick={()=>setShowFairUse(false)} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <span style={{fontWeight:700,fontSize:17}}>Fair Use Agreement</span>
      </div>
      <div style={{maxWidth:600,margin:"0 auto",padding:"24px 20px"}}>
        <div style={{fontSize:14,color:C.lt,lineHeight:1.8}}>
          <p style={{fontWeight:700,fontSize:16,color:C.txt,marginBottom:16}}>My Daily Reports — Fair Use Policy</p>
          <p style={{marginBottom:14}}>My Daily Reports uses AI-powered document parsing to analyze your uploaded templates and detect fillable fields. Each template upload triggers an API call to process your document. To keep the service fast, reliable, and affordable for all users, the following fair use limits apply:</p>
          <p style={{fontWeight:700,color:C.org,marginBottom:8}}>Job Creation Limits</p>
          <p style={{marginBottom:14}}>Each account is intended for use by a single inspector managing their own active projects. Users may create a reasonable number of jobs that reflect actual jobsite and field reporting work. Accounts that create an excessive number of jobs, upload templates in bulk, or appear to be using the parsing service for purposes other than daily field reporting may be subject to rate limiting or account review.</p>
          <p style={{fontWeight:700,color:C.org,marginBottom:8}}>Template Parsing</p>
          <p style={{marginBottom:14}}>The AI template parsing feature is provided to help you set up your report fields quickly. Each template upload counts as one parsing request. Re-uploading the same template for the same job counts as an additional request. Please configure your fields carefully during initial setup to minimize unnecessary re-parsing.</p>
          <p style={{fontWeight:700,color:C.org,marginBottom:8}}>Scheduling Calendar</p>
          <p style={{marginBottom:14}}>The shared scheduling calendar is designed for coordinating jobsite visits between you and your project teams. It is not intended for use as a general-purpose scheduling tool unrelated to jobsite and field reporting work.</p>
          <p style={{fontWeight:700,color:C.org,marginBottom:8}}>What Counts as Fair Use</p>
          <p style={{marginBottom:14}}>Creating jobs for real projects you are actively working on, uploading one template per job, adding your actual project team contacts, and using the calendar for legitimate jobsite scheduling. Normal use of the app as described in the Training Center is always within fair use.</p>
          <p style={{fontWeight:700,color:C.org,marginBottom:8}}>What May Trigger a Review</p>
          <p style={{marginBottom:14}}>Creating dozens of jobs in a short time period, repeatedly re-uploading and re-parsing the same templates, automated or scripted account activity, sharing account credentials, or using the service for purposes outside of jobsite and field reporting.</p>
          <p style={{fontWeight:700,color:C.org,marginBottom:8}}>Enforcement</p>
          <p style={{marginBottom:14}}>We reserve the right to temporarily rate-limit parsing requests, suspend scheduling features, or contact you to discuss your usage if it falls outside of normal patterns. We will always attempt to reach out before taking any action on your account.</p>
          <p style={{color:C.mut,fontSize:12,marginTop:20}}>Last updated: March 2026</p>
        </div>
      </div>
    </div>
  );

  const LegalSection=({icon,number,title,children})=>(
    <div style={{background:C.card,borderRadius:14,padding:16,marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        <span style={{fontSize:16,color:C.mut}}>{icon}</span>
        <span style={{fontWeight:700,fontSize:18,color:C.txt}}>{number}. {title}</span>
      </div>
      {children}
    </div>
  );
  const LP=({children,style})=><p style={{fontSize:15,color:C.lt,lineHeight:1.7,marginBottom:10,...style}}>{children}</p>;
  const LB=({items,boldPrefixes})=>(
    <div style={{paddingLeft:4,marginBottom:10}}>
      {items.map((item,i)=>{
        const bp=boldPrefixes?.find(p=>item.startsWith(p));
        return <div key={i} style={{display:"flex",gap:8,marginBottom:6,fontSize:15,color:C.lt,lineHeight:1.6}}>
          <span>•</span>{bp?<span><strong style={{color:C.txt}}>{bp}</strong>{item.slice(bp.length)}</span>:<span>{item}</span>}
        </div>;
      })}
    </div>
  );

  if(showTos)return(
    <div style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 16px",borderBottom:`1px solid ${C.brd}`,background:C.card}}>
        <button onClick={()=>setShowTos(false)} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <div><span style={{fontWeight:700,fontSize:17}}>Terms of Service</span><div style={{fontSize:11,color:C.mut}}>Last updated: January 11, 2025</div></div>
      </div>
      <div style={{maxWidth:600,margin:"0 auto",padding:"24px 20px"}}>
        <LP style={{color:C.mut,marginBottom:20}}>Welcome to My Daily Reports. By accessing or using our service, you agree to be bound by these Terms of Service. Please read them carefully before using the application.</LP>

        <LegalSection icon="—" number={1} title="Acceptance of Terms">
          <LP>By creating an account or using My Daily Reports ("the Service"), you agree to these Terms of Service, our Privacy Policy, and any additional terms applicable to certain features. If you do not agree to these terms, you may not use the Service.</LP>
          <LP>We reserve the right to modify these terms at any time. Continued use of the Service after changes constitutes acceptance of the new terms. We will notify users of material changes via email or in-app notification.</LP>
        </LegalSection>

        <LegalSection icon="→" number={2} title="Description of Service">
          <LP>My Daily Reports is a mobile and web application designed for construction industry professionals, particularly Project Inspectors and Inspectors of Record (IOR), to create, manage, and export daily field reports. The Service includes:</LP>
          <LB items={["Daily report creation and management","Photo documentation and attachment","PDF generation and export","Time tracking and job management","AI-powered document parsing (Premium feature)","Scheduling request management (Premium feature)"]}/>
        </LegalSection>

        <LegalSection icon="—" number={3} title="User Accounts and Registration">
          <LP>To use certain features, you must create an account. You agree to:</LP>
          <LB items={["Provide accurate, current, and complete information during registration","Maintain the security of your password and account","Accept responsibility for all activities under your account","Notify us immediately of any unauthorized use"]}/>
          <LP>You must be at least 18 years old to use this Service. Accounts registered by automated methods are not permitted.</LP>
        </LegalSection>

        <LegalSection icon="—" number={4} title="Subscription and Payments">
          <LP>The Service offers free and paid subscription tiers:</LP>
          <LB items={["Free Tier: Limited to 1 job, 1 report per week, 2 photos per report","Silver Tier: Extended limits, draft saving, voice input","Premium Tier: Unlimited usage, AI features, advanced reporting","Enterprise Tier: All features plus priority support"]} boldPrefixes={["Free Tier:","Silver Tier:","Premium Tier:","Enterprise Tier:"]}/>
          <LP>Paid subscriptions are billed in advance on a monthly or annual basis. Subscriptions automatically renew unless cancelled before the renewal date. Refunds are handled according to applicable app store policies (Apple App Store, Google Play Store).</LP>
        </LegalSection>

        <LegalSection icon="—" number={5} title="App Store Terms and Compliance">
          <LP>If you access the Service through Apple's App Store or Google Play:</LP>
          <LB items={["These terms are between you and My Daily Reports, not Apple or Google","Apple/Google have no obligation to provide maintenance or support","Apple/Google are third-party beneficiaries of these terms","In-app purchases are processed through respective app stores","Refund requests should be directed to the respective app store"]}/>
          <LP>We comply with Apple's App Store Review Guidelines and Google Play Developer Program Policies.</LP>
        </LegalSection>

        <LegalSection icon="🔒" number={6} title="User Content and Data">
          <LP>You retain ownership of all content you create using the Service ("User Content"), including reports, photos, and documentation. By using the Service, you grant us a limited license to:</LP>
          <LB items={["Store and process your content to provide the Service","Create backups for data protection","Generate PDF reports from your data"]}/>
          <LP>We do not claim ownership of your User Content. You are responsible for ensuring you have rights to any content you upload. User Content is stored securely with access restricted to your account only.</LP>
        </LegalSection>

        <LegalSection icon="—" number={7} title="Intellectual Property Rights">
          <LP>The Service, including its original content, features, and functionality, is owned by My Daily Reports and protected by international copyright, trademark, and other intellectual property laws.</LP>
          <LP>You may not:</LP>
          <LB items={["Copy, modify, or distribute the application or its content","Reverse engineer, decompile, or disassemble the software","Remove any copyright or proprietary notices","Use the Service to develop competing products","Attempt to bypass subscription restrictions or access premium features without authorization"]}/>
        </LegalSection>

        <LegalSection icon="⚠️" number={8} title="Prohibited Uses">
          <LP>You agree not to use the Service to:</LP>
          <LB items={["Violate any applicable laws or regulations","Submit false or misleading inspection reports","Impersonate any person or entity","Interfere with or disrupt the Service or servers","Attempt unauthorized access to any part of the Service","Use automated scripts to access the Service","Transmit viruses, malware, or other harmful code","Harvest or collect user information without consent"]}/>
        </LegalSection>

        <LegalSection icon="📋" number={9} title="Professional Responsibility and Disclaimer">
          <LP>The Service is a documentation tool and does not replace professional judgment. Users are responsible for:</LP>
          <LB items={["Accuracy and completeness of all reports and documentation","Compliance with applicable building codes, regulations, and standards","Professional licensing requirements in their jurisdiction","Verification of AI-generated content and suggestions"]}/>
          <LP><strong style={{color:C.txt}}>DISCLAIMER:</strong> The Service is provided "AS IS" without warranties of any kind. We do not warrant that reports generated will meet regulatory requirements or professional standards in any specific jurisdiction. AI features provide suggestions only and should be verified by qualified professionals.</LP>
        </LegalSection>

        <LegalSection icon="—" number={10} title="Limitation of Liability">
          <LP>TO THE MAXIMUM EXTENT PERMITTED BY LAW:</LP>
          <LB items={["We shall not be liable for any indirect, incidental, special, consequential, or punitive damages","Our total liability shall not exceed the amount paid by you in the 12 months preceding the claim","We are not liable for any loss of data, business interruption, or professional consequences"]}/>
          <LP>Some jurisdictions do not allow limitations on implied warranties or exclusion of certain damages, so these limitations may not apply to you.</LP>
        </LegalSection>

        <LegalSection icon="→" number={11} title="Termination">
          <LP>We may terminate or suspend your account immediately, without prior notice, for conduct that we determine violates these Terms or is harmful to other users, us, or third parties. Upon termination:</LP>
          <LB items={["Your right to use the Service will immediately cease","You may export your data before termination if possible","We may delete your data after a reasonable retention period"]}/>
          <LP>You may terminate your account at any time through the app settings. Prepaid subscription fees are handled according to app store refund policies.</LP>
        </LegalSection>

        <LegalSection icon="—" number={12} title="Governing Law and Dispute Resolution">
          <LP>These Terms shall be governed by the laws of the State of California, United States, without regard to its conflict of law provisions.</LP>
          <LP>Any disputes arising from these Terms or the Service shall first be attempted to be resolved through good-faith negotiation. If resolution is not reached within 30 days, disputes shall be submitted to binding arbitration in accordance with the rules of the American Arbitration Association.</LP>
        </LegalSection>

        <LegalSection icon="—" number={13} title="Contact Information">
          <LP>If you have questions about these Terms of Service, please contact us:</LP>
          <LB items={["Email: support@mydailyreports.org","In-app: Profile → Help & Support"]}/>
        </LegalSection>

        <div style={{textAlign:"center",padding:"16px 0 32px"}}>
          <LP style={{color:C.mut,fontSize:13}}>Please also review our Privacy Policy which describes how we collect, use, and protect your personal information.</LP>
          <div style={{display:"flex",gap:12,justifyContent:"center",marginTop:12}}>
            <button onClick={()=>{setShowTos(false);setShowPriv(true);}} style={{padding:"10px 20px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.lt,fontSize:14,fontWeight:600,cursor:"pointer"}}>Privacy Policy</button>
            <button onClick={()=>setShowTos(false)} style={{padding:"10px 20px",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:14,fontWeight:600,cursor:"pointer"}}>Return to App</button>
          </div>
        </div>
      </div>
    </div>
  );

  if(showPriv)return(
    <div style={{minHeight:"100vh",background:C.bg,color:C.txt}}>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 16px",borderBottom:`1px solid ${C.brd}`,background:C.card}}>
        <button onClick={()=>setShowPriv(false)} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:12,color:"#fff",fontSize:26,cursor:"pointer",lineHeight:1,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}aria-label="Go back">←</button>
        <div><span style={{fontWeight:700,fontSize:17}}>Privacy Policy</span><div style={{fontSize:11,color:C.mut}}>Last updated: January 11, 2025</div></div>
      </div>
      <div style={{maxWidth:600,margin:"0 auto",padding:"24px 20px"}}>
        <LP style={{color:C.mut,marginBottom:20}}>My Daily Reports ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our mobile and web application.</LP>

        <LegalSection icon="—" number={1} title="Information We Collect">
          <p style={{fontWeight:700,fontSize:15,color:C.txt,marginBottom:6,marginTop:4}}>Account Information</p>
          <LB items={["Email address","Display name (optional)","Password (encrypted)"]}/>
          <p style={{fontWeight:700,fontSize:15,color:C.txt,marginBottom:6,marginTop:4}}>User-Generated Content</p>
          <LB items={["Daily inspection reports and their contents","Photos and images you upload","Job and project information","Time tracking data","Notes and documentation"]}/>
          <p style={{fontWeight:700,fontSize:15,color:C.txt,marginBottom:6,marginTop:4}}>Automatically Collected Information</p>
          <LB items={["Device type and operating system","App version","Usage patterns and feature interactions","Error logs for troubleshooting"]}/>
        </LegalSection>

        <LegalSection icon="—" number={2} title="How We Use Your Information">
          <LP>We use collected information to:</LP>
          <LB items={["Provide, maintain, and improve the Service","Generate PDF reports from your data","Process AI-powered features (document parsing, suggestions)","Send service-related notifications and updates","Respond to customer support requests","Detect and prevent fraud or abuse","Comply with legal obligations"]}/>
          <LP><strong style={{color:C.txt}}>AI Processing:</strong> When you use AI-powered features, your content may be processed by third-party AI services (such as Anthropic Claude) to provide functionality. This processing is done securely and data is not used to train AI models.</LP>
        </LegalSection>

        <LegalSection icon="→" number={3} title="Information Sharing and Disclosure">
          <LP>We do not sell your personal information. We may share information with:</LP>
          <LB items={["Service Providers: Third parties that help us operate the Service (hosting, payment processing, analytics)","AI Services: For processing AI-powered features (with data protection agreements in place)","Legal Requirements: When required by law or to protect our rights","Business Transfers: In connection with a merger, acquisition, or sale of assets"]} boldPrefixes={["Service Providers:","AI Services:","Legal Requirements:","Business Transfers:"]}/>
          <LP>Your reports and project data are never shared with other users or third parties without your explicit consent.</LP>
        </LegalSection>

        <LegalSection icon="—" number={4} title="Data Security">
          <LP>We implement industry-standard security measures including:</LP>
          <LB items={["Encryption of data in transit (TLS/SSL) and at rest","Row-Level Security (RLS) ensuring users can only access their own data","Secure authentication with password hashing","Regular security audits and monitoring","Access controls limiting employee access to user data"]}/>
          <LP>While we strive to protect your information, no method of transmission over the internet is 100% secure. We cannot guarantee absolute security.</LP>
        </LegalSection>

        <LegalSection icon="—" number={5} title="Data Retention">
          <LP>We retain your information as follows:</LP>
          <LB items={["Account Data: Retained while your account is active","Reports and Content: Retained until you delete them or your account","Backups: May be retained for up to 30 days after deletion","Legal Requirements: Some data may be retained longer if required by law"]} boldPrefixes={["Account Data:","Reports and Content:","Backups:","Legal Requirements:"]}/>
          <LP>You can request deletion of your account and data at any time through the app settings.</LP>
        </LegalSection>

        <LegalSection icon="→" number={6} title="Your Privacy Rights">
          <LP>Depending on your location, you may have the right to:</LP>
          <LB items={["Access: Request a copy of your personal data","Correction: Request correction of inaccurate data","Deletion: Request deletion of your personal data","Export: Download your data in a portable format","Opt-out: Unsubscribe from marketing communications"]} boldPrefixes={["Access:","Correction:","Deletion:","Export:","Opt-out:"]}/>
          <LP>To exercise these rights, contact us at support@mydailyreports.org or use the in-app settings.</LP>
        </LegalSection>

        <LegalSection icon="—" number={7} title="International Data Transfers">
          <LP>Your information may be transferred to and processed in countries other than your country of residence. These countries may have different data protection laws.</LP>
          <LP>We ensure appropriate safeguards are in place for international transfers, including standard contractual clauses and compliance with applicable data protection regulations.</LP>
        </LegalSection>

        <LegalSection icon="—" number={8} title="Children's Privacy">
          <LP>The Service is not intended for users under 18 years of age. We do not knowingly collect personal information from children. If we become aware that we have collected data from a child, we will take steps to delete that information.</LP>
        </LegalSection>

        <LegalSection icon="🔔" number={9} title="Changes to This Privacy Policy">
          <LP>We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the "Last updated" date.</LP>
          <LP>For material changes, we will provide additional notice via email or in-app notification. Your continued use of the Service after changes constitutes acceptance of the updated policy.</LP>
        </LegalSection>

        <LegalSection icon="—" number={10} title="Contact Us">
          <LP>If you have questions about this Privacy Policy or our data practices, please contact us:</LP>
          <LB items={["Email: privacy@mydailyreports.app","In-app: Profile → Help & Support"]}/>
          <LP>For data protection inquiries from the EU, you may also contact our Data Protection Officer at support@mydailyreports.org.</LP>
        </LegalSection>

        <div style={{textAlign:"center",padding:"16px 0 32px"}}>
          <LP style={{color:C.mut,fontSize:13}}>This Privacy Policy should be read in conjunction with our Terms of Service.</LP>
          <div style={{display:"flex",gap:12,justifyContent:"center",marginTop:12}}>
            <button onClick={()=>{setShowPriv(false);setShowTos(true);}} style={{padding:"10px 20px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:10,color:C.lt,fontSize:14,fontWeight:600,cursor:"pointer"}}>Terms of Service</button>
            <button onClick={()=>setShowPriv(false)} style={{padding:"10px 20px",background:C.card,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,fontSize:14,fontWeight:600,cursor:"pointer"}}>Return to App</button>
          </div>
        </div>
      </div>
    </div>
  );

  // Subscription checkout helper
  const startCheckout=async(priceId)=>{
    try{
      const d=await api.createCheckout({user_id:user.id,price_id:priceId});
      if(d.url)window.location.href=d.url;
      else showToast(d.error||"Checkout failed");
    }catch(e){showToast("Checkout error: "+e.message);}
  };

  // Paywall screen — shown when trial expired or subscription cancelled
  if(subStatus==="expired"||subStatus==="cancelled"||subStatus==="trial_abused"){
    const PRICE_MONTHLY=localStorage.getItem("mdr_price_monthly")||"";
    const PRICE_ANNUAL=localStorage.getItem("mdr_price_annual")||"";
    return(
      <div style={{minHeight:"100vh",background:C.bg,color:C.txt,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:20}}>
        <div style={{maxWidth:420,width:"100%",textAlign:"center"}}>
          <MDRLogo size={72}/>
          <div style={{fontSize:22,fontWeight:800,marginTop:16,marginBottom:8}}>
            {subStatus==="trial_abused"?"Trial Not Available":"Your Free Trial Has Ended"}
          </div>
          <div style={{fontSize:14,color:C.mut,lineHeight:1.6,marginBottom:28}}>
            {subStatus==="trial_abused"
              ?"This card has already been used for a free trial on another account."
              :"Subscribe to continue creating reports, managing jobs, and using all features. Your data is safe — pick a plan to get back to work."}
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
            <button onClick={()=>startCheckout(PRICE_MONTHLY)} style={{padding:"16px 20px",background:C.org,border:"none",borderRadius:12,color:"#fff",fontSize:16,fontWeight:700,cursor:"pointer"}}>
              $19.99 / month
            </button>
            <button onClick={()=>startCheckout(PRICE_ANNUAL)} style={{padding:"16px 20px",background:C.blu,border:"none",borderRadius:12,color:"#fff",fontSize:16,fontWeight:700,cursor:"pointer"}}>
              $199 / year <span style={{fontSize:12,fontWeight:400,opacity:0.8}}>— save 17%</span>
            </button>
          </div>

          <div style={{padding:16,background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,marginBottom:16}}>
            <div style={{fontSize:13,fontWeight:700,color:C.lt,marginBottom:8}}>Other Payment Options</div>
            <div style={{fontSize:12,color:C.mut,lineHeight:1.6}}>
              <strong style={{color:C.lt}}>PayPal / Venmo:</strong> Available at checkout (select PayPal as payment method)
            </div>
            <div style={{fontSize:12,color:C.mut,lineHeight:1.6,marginTop:6}}>
              <strong style={{color:C.lt}}>Zelle:</strong> Send $19.99/mo or $199/yr to <span style={{color:C.org}}>support@mydailyreports.org</span> — we'll activate your account within 24 hours
            </div>
            <div style={{fontSize:12,color:C.mut,lineHeight:1.6,marginTop:6}}>
              <strong style={{color:C.lt}}>Crypto:</strong> <a href="mailto:support@mydailyreports.org?subject=Crypto%20Payment%20Inquiry" style={{color:C.org}}>Contact us</a> for cryptocurrency payment options
            </div>
          </div>

          <div style={{fontSize:13,fontWeight:700,color:C.lt,marginBottom:8}}>Enterprise</div>
          <div style={{fontSize:12,color:C.mut,lineHeight:1.6,marginBottom:16}}>
            Unlimited jobs, unlimited AI, company-wide templates, dedicated support, and custom integrations.{" "}
            <a href="mailto:support@mydailyreports.org?subject=Enterprise%20Inquiry" style={{color:C.org}}>Contact us</a>
          </div>

          <button onClick={()=>{authLogout();window.location.reload();}} style={{padding:"10px 20px",background:"none",border:`1px solid ${C.brd}`,borderRadius:8,color:C.mut,fontSize:13,cursor:"pointer"}}>
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  if(selJob)return(
    <JobDetail job={selJob} user={user} onBack={()=>{setSelJob(null);saveNav(null);load();}} onDeleted={()=>{setSelJob(null);saveNav(null);load();}}/>
  );

  return(
    <div style={{minHeight:"100vh",background:C.bg,color:C.txt,position:"relative"}} onClick={e=>{if(showSet&&!e.target.closest('[data-s]'))setShowSet(false);if(showDD&&!e.target.closest('[data-d]'))setShowDD(false);}}>
      {dashToast&&<div style={{position:"fixed",bottom:30,left:"50%",transform:"translateX(-50%)",background:"#333",color:"#fff",padding:"10px 20px",borderRadius:8,fontSize:13,zIndex:99999}}>{dashToast}</div>}
      {/* ── Header: Dropdown (left) | Logo (center) | Settings (right) ── */}
      <div style={{borderBottom:`1px solid ${C.brd}`,background:C.card,padding:"12px 16px"}} data-s>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",maxWidth:600,margin:"0 auto"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}} data-d>
          <button onClick={()=>setShowDD(!showDD)} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 12px",background:C.inp,border:`1px solid ${showDD?C.org:C.brd}`,borderRadius:8,cursor:"pointer",color:C.txt}}>
            <span style={{fontSize:14,fontWeight:600,maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selJob?selJob.name:"Jobs"}</span>
            <span style={{color:C.mut,fontSize:11,transform:showDD?"rotate(180deg)":"none",transition:"transform 0.2s"}}>▼</span>
          </button>
          {dashLogoUrl&&<img src={dashLogoUrl} alt="" style={{width:34,height:34,borderRadius:8,objectFit:"contain",background:"#fff",border:`1px solid ${C.brd}`}}/>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button onClick={()=>{const s=profileSlug||user?.user_metadata?.full_name?.toLowerCase().replace(/\s+/g,"-")||"inspector";window.location.href=`${window.location.origin}${window.location.pathname.replace(/index\.html$/,"").replace(/\/$/,"")}/hub.html?i=${s}`;}} style={{width:56,height:56,borderRadius:12,background:C.inp,border:`1px solid ${C.brd}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:28,color:"#fff"}} title="Open scheduling hub">📅</button>
          <button onClick={()=>setShowSet(!showSet)} style={{width:56,height:56,borderRadius:12,background:C.inp,border:`1px solid ${C.brd}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:28,color:"#fff"}}aria-label="Settings">⚙️</button>
        </div>
      </div>
      </div>

      {/* Trial countdown banner */}
      {subStatus==="trialing"&&trialEndsAt&&(()=>{
        const days=Math.max(0,Math.ceil((trialEndsAt-new Date())/(1000*60*60*24)));
        return days<=7?(
          <div style={{padding:"10px 16px",background:days<=3?"rgba(239,68,68,0.15)":"rgba(232,116,42,0.12)",borderBottom:`1px solid ${C.brd}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{fontSize:12,color:days<=3?C.err:C.org,fontWeight:600}}>
              {days===0?"Trial ends today":days===1?"Trial ends tomorrow":`${days} days left in your free trial`}
            </div>
            <button onClick={()=>setShowPaywall(true)} style={{padding:"4px 12px",background:C.org,border:"none",borderRadius:6,color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer"}}>Subscribe</button>
          </div>
        ):null;
      })()}

      {/* Job dropdown */}
      {showDD&&(
        <div style={{position:"absolute",left:16,top:62,background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,marginTop:4,zIndex:90,boxShadow:"0 8px 24px rgba(0,0,0,0.5)",maxHeight:400,overflowY:"auto",minWidth:240}} data-d>
          {act.length===0&&<div style={{padding:16,textAlign:"center",color:C.mut,fontSize:14}}>No active jobs</div>}
          {act.map(j=>{const s=stat(j.id,j.schedule);return(
            <button key={j.id} onClick={()=>{selectJob(j);setShowDD(false);}} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"14px 16px",background:"none",border:"none",borderBottom:`1px solid ${C.brd}`,cursor:"pointer",textAlign:"left"}}>
              {dot(s)}<div style={{flex:1}}><div style={{fontSize:15,fontWeight:600,color:C.txt}}>{j.name}</div><span style={{fontSize:11,color:C.mut}}>{SL[j.schedule]||j.schedule}</span></div>
            </button>);})}
        </div>
      )}

      {/* Settings dropdown */}
      {showSet&&(
        <div style={{position:"absolute",top:62,right:16,background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:"8px 0",minWidth:220,zIndex:100,boxShadow:"0 8px 24px rgba(0,0,0,0.5)"}} data-s>
          <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.brd}`}}>
            <div style={{fontWeight:600,fontSize:14,color:C.txt,marginBottom:2}}>{user?.user_metadata?.full_name||"Inspector"}</div>
            <div style={{fontSize:12,color:C.mut}}>{user?.email}</div>
          </div>
          <button onClick={()=>{setShowSet(false);setShowAcct(true);}} style={{width:"100%",padding:"12px 16px",background:"none",border:"none",textAlign:"left",color:C.lt,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",gap:10}}>Account Settings</button>
          <div style={{borderTop:`1px solid ${C.brd}`,margin:"4px 0"}}/>
          <button onClick={()=>{setShowSet(false);onLogout();}} style={{width:"100%",padding:"12px 16px",background:"none",border:"none",textAlign:"left",color:"#ef4444",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",gap:10}}>Sign Out</button>
        </div>
      )}

      <div style={{maxWidth:600,margin:"0 auto",padding:"16px 16px 20px",overflowX:"hidden"}}>
        <button className="btn-o" onClick={()=>setShowNew(true)} style={{width:"100%",padding:"14px 0",background:C.org,border:`1px solid ${C.blu}`,borderRadius:10,color:"#fff",fontSize:16,fontWeight:700,cursor:"pointer",marginBottom:16}}>+ New Job</button>

        {loading&&<p style={{textAlign:"center",color:C.mut,padding:40}}>Loading...</p>}

        {/* ── Job cards — two column grid, max 4 visible ── */}
        {!loading&&act.length>0&&(
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16,overflow:"hidden"}}>
            {visibleJobs.map(j=>{const s=stat(j.id,j.schedule);const sc=s==="submitted"?C.ok:s==="working"?C.org:s==="due"?"#ef4444":C.brd;return(
              <button key={j.id} onClick={()=>selectJob(j)} style={{textAlign:"left",background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:14,cursor:"pointer",display:"flex",flexDirection:"column",gap:8,position:"relative",borderTop:`3px solid ${sc}`,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0}}>
                  <div style={{width:36,height:36,borderRadius:8,background:C.inp,border:`1px solid ${C.brd}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:C.mut,flexShrink:0}}>{j.job_type==="worklog"?"WL":"T"}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:14,color:C.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{j.name}</div>
                  </div>
                  {j.scheduling_enabled&&<span style={{fontSize:14,flexShrink:0}} title="Scheduling enabled">📅</span>}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <span style={{fontSize:10,fontWeight:600,background:C.inp,border:`1px solid ${C.brd}`,borderRadius:4,padding:"2px 6px",color:C.mut}}>{SL[j.schedule]||j.schedule}</span>
                  {s!=="none"&&<span style={{fontSize:10,fontWeight:700,color:sc}}>{s==="submitted"?"Done":s==="working"?"In Progress":"Due"}</span>}
                </div>
                {j.site_address&&<div style={{fontSize:11,color:C.mut,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{j.site_address}</div>}
              </button>);})}
          </div>
        )}
        {!loading&&sortedAct.length>4&&(
          <div style={{textAlign:"center",marginBottom:12,marginTop:-6}}>
            <button onClick={()=>setShowDD(true)} style={{background:"none",border:"none",color:C.mut,fontSize:12,cursor:"pointer",padding:"4px 8px"}}>+{sortedAct.length-4} more — tap Jobs dropdown to see all</button>
          </div>
        )}

        {!loading&&act.length===0&&(<div style={{textAlign:"center",padding:"60px 20px",color:C.mut}}><div style={{fontSize:48,marginBottom:16,color:C.brd}}>—</div><p style={{fontSize:16,fontWeight:600,color:C.lt,marginBottom:6}}>No jobs yet</p><p style={{fontSize:14}}>Tap "+ New Job" to create your first project</p></div>)}

        {/* ── Scheduling Calendar (full month) ── */}
        {!loading&&(()=>{
          const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
          const now=new Date();
          const todayStr=now.toLocaleDateString("en-CA",{timeZone:tz});
          const monthLabel=new Date(calYear,calMonth,1).toLocaleDateString("en-US",{month:"long",year:"numeric"});
          const firstDay=new Date(calYear,calMonth,1);
          const lastDay=new Date(calYear,calMonth+1,0);
          const startPad=firstDay.getDay();
          const totalDays=lastDay.getDate();
          const cells=[];
          for(let i=0;i<startPad;i++)cells.push(null);
          for(let d=1;d<=totalDays;d++)cells.push(d);
          while(cells.length%7!==0)cells.push(null);
          const slug=profileSlug||user?.user_metadata?.full_name?.toLowerCase().replace(/\s+/g,"-")||"inspector";
          const calURL=`${window.location.origin}${window.location.pathname.replace(/index\.html$/,"").replace(/\/$/,"")}/hub.html?i=${slug}`;
          const hasScheduling=act.some(j=>j.scheduling_enabled);
          const dayHeaders=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
          // Build lookup: date string → array of requests
          const reqsByDay={};
          calRequests.forEach(rq=>{if(!reqsByDay[rq.requested_date])reqsByDay[rq.requested_date]=[];reqsByDay[rq.requested_date].push(rq);});
          // Requests for selected day
          const selDayReqs=selCalDay?reqsByDay[selCalDay]||[]:[];
          const prevMonth=()=>{const m=calMonth-1;if(m<0){setCalYear(calYear-1);setCalMonth(11);}else setCalMonth(m);setSelCalDay(null);};
          const nextMonth=()=>{const m=calMonth+1;if(m>11){setCalYear(calYear+1);setCalMonth(0);}else setCalMonth(m);setSelCalDay(null);};
          return(
            <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,overflow:"hidden",marginBottom:12}}>
              {/* Calendar header with nav */}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 16px",borderBottom:`1px solid ${C.brd}`}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <button onClick={prevMonth} style={{background:"none",border:"none",color:C.mut,fontSize:18,cursor:"pointer",padding:"0 4px"}}>‹</button>
                  <span style={{fontWeight:700,fontSize:15,color:C.txt}}>{monthLabel}</span>
                  <button onClick={nextMonth} style={{background:"none",border:"none",color:C.mut,fontSize:18,cursor:"pointer",padding:"0 4px"}}>›</button>
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={async()=>{try{await navigator.clipboard.writeText(calURL);setShareCopied(true);setTimeout(()=>setShareCopied(false),2000);}catch(e){showToast("Couldn't copy — long-press the link");}}} style={{padding:"6px 12px",fontSize:12,fontWeight:700,borderRadius:6,background:shareCopied?"#22c55e":C.blu,border:"none",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",gap:4,transition:"background 0.2s"}}>
                    {shareCopied?"Copied!":"Share"}
                  </button>
                  <button onClick={()=>setShowSubDash(!showSubDash)} style={{padding:"6px 12px",fontSize:12,fontWeight:700,borderRadius:6,background:showSubDash?C.org:C.blu,border:"none",color:"#fff",cursor:"pointer"}}>
                    Subscribe
                  </button>
                </div>
              </div>
              {/* Day headers */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)"}}>
                {dayHeaders.map((d,i)=>(
                  <div key={d} style={{padding:"8px 0",textAlign:"center",fontSize:10,fontWeight:700,color:(i===0||i===6)?C.mut+"88":C.mut,textTransform:"uppercase",borderBottom:`1px solid ${C.brd}`}}>{d}</div>
                ))}
              </div>
              {/* Month grid */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)"}}>
                {cells.map((day,i)=>{
                  if(day===null)return<div key={i} style={{padding:"6px 4px",textAlign:"center"}}/>;
                  const ds=`${calYear}-${String(calMonth+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
                  const isToday=ds===todayStr;
                  const isSel=ds===selCalDay;
                  const isWeekend=i%7===0||i%7===6;
                  const dayReqs=reqsByDay[ds]||[];
                  const hasConfirmed=dayReqs.some(r=>r.status==="scheduled");
                  const hasPending=dayReqs.some(r=>r.status==="pending");
                  const hasBlocked=dayReqs.some(r=>(r.inspection_types||[]).includes("Blocked"));
                  return(
                    <div key={i} onClick={()=>setSelCalDay(isSel?null:ds)} style={{padding:"4px 2px",textAlign:"center",background:isSel?C.blu+"22":isToday?"#5a8fc022":"transparent",cursor:"pointer",borderBottom:isSel?`2px solid ${C.blu}`:"2px solid transparent"}}>
                      <div style={{width:28,height:28,borderRadius:"50%",background:isToday&&!isSel?"#5a8fc0":isSel?C.blu:"transparent",color:(isToday&&!isSel)||isSel?"#fff":isWeekend?C.mut:C.lt,fontWeight:isToday||isSel?700:500,fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto"}}>{day}</div>
                      {/* Dots for requests */}
                      <div style={{display:"flex",justifyContent:"center",gap:3,marginTop:2,minHeight:6}}>
                        {hasBlocked&&<div style={{width:5,height:5,borderRadius:"50%",background:C.err}}/>}
                        {hasConfirmed&&<div style={{width:5,height:5,borderRadius:"50%",background:"#22c55e"}}/>}
                        {hasPending&&<div style={{width:5,height:5,borderRadius:"50%",background:C.org}}/>}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Selected day details */}
              {selCalDay&&(
                <div style={{borderTop:`1px solid ${C.brd}`,padding:"12px 16px"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{fontSize:13,fontWeight:700,color:C.txt}}>{new Date(selCalDay+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</div>
                    <button onClick={()=>setShowBlockTime(!showBlockTime)} style={{padding:"4px 10px",fontSize:11,fontWeight:700,borderRadius:6,border:`1px solid ${C.brd}`,background:showBlockTime?C.err+"22":"transparent",color:showBlockTime?C.err:C.mut,cursor:"pointer"}}>{showBlockTime?"Cancel":"+ Block Time"}</button>
                  </div>
                  {showBlockTime&&(
                    <div style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,padding:12,marginBottom:10}}>
                      <div style={{fontSize:12,fontWeight:600,color:C.lt,marginBottom:8}}>Block off time — prevents scheduling</div>
                      <div style={{display:"flex",gap:8,marginBottom:8}}>
                        <div style={{flex:1}}>
                          <label style={{fontSize:11,color:C.mut,display:"block",marginBottom:4}}>Start</label>
                          <select value={blockTimeStart} onChange={e=>setBlockTimeStart(e.target.value)} style={{width:"100%",padding:"8px",background:C.bg,border:`1px solid ${C.brd}`,borderRadius:6,color:C.txt,fontSize:13}}>
                            {["05:00","05:30","06:00","06:30","07:00","07:30","08:00","08:30","09:00","09:30","10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00"].map(t=><option key={t} value={t}>{((h)=>h>12?(h-12):h===0?12:h)(parseInt(t.split(":")[0]))+":"+t.split(":")[1]} {parseInt(t.split(":")[0])>=12?"PM":"AM"}</option>)}
                          </select>
                        </div>
                        <div style={{flex:1}}>
                          <label style={{fontSize:11,color:C.mut,display:"block",marginBottom:4}}>End</label>
                          <select value={blockTimeEnd} onChange={e=>setBlockTimeEnd(e.target.value)} style={{width:"100%",padding:"8px",background:C.bg,border:`1px solid ${C.brd}`,borderRadius:6,color:C.txt,fontSize:13}}>
                            {["05:30","06:00","06:30","07:00","07:30","08:00","08:30","09:00","09:30","10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00"].map(t=><option key={t} value={t}>{((h)=>h>12?(h-12):h===0?12:h)(parseInt(t.split(":")[0]))+":"+t.split(":")[1]} {parseInt(t.split(":")[0])>=12?"PM":"AM"}</option>)}
                          </select>
                        </div>
                      </div>
                      <input type="text" value={blockTimeNote} onChange={e=>setBlockTimeNote(e.target.value)} placeholder="Reason (e.g. Weekly meeting)" aria-label="Block time reason" style={{width:"100%",boxSizing:"border-box",padding:"8px 10px",background:C.bg,border:`1px solid ${C.brd}`,borderRadius:6,color:C.txt,fontSize:13,marginBottom:8}}/>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                        <input type="checkbox" id="blockRepeat" checked={blockTimeRepeat} onChange={e=>setBlockTimeRepeat(e.target.checked)} style={{width:18,height:18,accentColor:C.org}}/>
                        <label htmlFor="blockRepeat" style={{fontSize:12,color:C.lt,cursor:"pointer"}}>Repeat every week (12 weeks)</label>
                      </div>
                      <button disabled={blockTimeSaving} onClick={async()=>{
                        setBlockTimeSaving(true);
                        try{
                          const schedJob=act.find(j=>j.scheduling_enabled);
                          if(!schedJob){showToast("Enable scheduling on a job first");setBlockTimeSaving(false);return;}
                          const proj=(schedJob.name||"").toLowerCase().replace(/[^a-z0-9]+/g,"-");
                          const dur=((parseInt(blockTimeEnd.split(":")[0])*60+parseInt(blockTimeEnd.split(":")[1]))-(parseInt(blockTimeStart.split(":")[0])*60+parseInt(blockTimeStart.split(":")[1])));
                          const weeks=blockTimeRepeat?12:1;
                          let created=0;
                          for(let w=0;w<weeks;w++){
                            const d=new Date(selCalDay+"T12:00:00");
                            d.setDate(d.getDate()+(w*7));
                            const dateStr=d.toLocaleDateString("en-CA");
                            const fd=new FormData();
                            fd.append("project",proj); fd.append("job_id",schedJob.id);
                            fd.append("inspection_date",dateStr);
                            fd.append("inspection_time",blockTimeStart);
                            fd.append("inspection_types",JSON.stringify(["Blocked"]));
                            fd.append("duration",String(Math.max(dur,30)));
                            fd.append("submitted_by",user?.user_metadata?.full_name||user?.email||"Admin");
                            fd.append("notes",blockTimeNote.trim()||"Blocked — personal commitment");
                            fd.append("email_recipients","[]");
                            try{
                              await api.submitInspection(fd);
                              created++;
                            }catch(e){console.error("Block week "+w+":",e);}
                          }
                          showToast(created>1?`Blocked ${created} weeks`:"Time blocked");
                          setShowBlockTime(false);setBlockTimeNote("");setBlockTimeRepeat(false);
                          await loadRequests();
                        }catch(e){showToast("Error: "+e.message);}
                        finally{setBlockTimeSaving(false);}
                      }} style={{width:"100%",padding:"10px 0",background:C.err,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:blockTimeSaving?"default":"pointer",opacity:blockTimeSaving?0.6:1}}>
                        {blockTimeSaving?"Blocking...":"Block This Time"}
                      </button>
                    </div>
                  )}
                  {selDayReqs.length===0&&!showBlockTime?(
                    <div style={{fontSize:12,color:C.mut}}>No scheduling requests for this day.</div>
                  ):(
                    selDayReqs.map(rq=>(
                      <div key={rq.id} style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,padding:12,marginBottom:8,position:"relative"}}>
                        {rq.status==="scheduled"&&<div style={{position:"absolute",top:8,right:10,fontSize:16}}>✅</div>}
                        <div style={{fontSize:13,fontWeight:700,color:C.txt}}>{rq.jobs?.name||(rq.project||"Job").replace(/-/g," ").replace(/\b\w/g,c=>c.toUpperCase())}</div>
                        <div style={{fontSize:12,color:C.lt,marginTop:2}}>{rq.inspection_type||(rq.inspection_types||[])[0]||"General Visit"}{rq.special_type?` — ${rq.special_type}`:""} — {rq.requester_name||rq.submitted_by||""}</div>
                        {rq.inspection_time&&<div style={{fontSize:11,color:C.blu,marginTop:2}}>{(rq.inspection_time+"").substring(0,5)}{rq.duration?` (${rq.duration>=60?rq.duration/60+"hr":rq.duration+"min"})`:""}</div>}
                        <div style={{fontSize:11,color:C.mut,marginTop:2}}>{rq.requester_email}{rq.requester_company?` · ${rq.requester_company}`:""}</div>
                        {rq.inspection_identifier&&<div style={{fontSize:11,color:C.mut,marginTop:2}}>#{rq.inspection_identifier}</div>}
                        {rq.notes&&<div style={{fontSize:11,color:C.mut,marginTop:4,fontStyle:"italic"}}>{rq.notes}</div>}
                        <div style={{display:"flex",gap:8,marginTop:10}}>
                          {rq.status!=="scheduled"&&(
                            <button onClick={async(e)=>{e.stopPropagation();const btn=e.currentTarget;if(btn.disabled)return;btn.disabled=true;btn.style.opacity="0.5";try{
                              // Use update-inspection edge function so notification prefs are respected
                              await api.updateInspection.schedule({request_id:rq.id});
                              // Also send confirmation email to requester (external party) — separate from owner notifications
                              if(rq.requester_email){
                                const reqDate=new Date(rq.requested_date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
                                const inspectorName=user?.user_metadata?.full_name||user?.email||"Your inspector";
                                const prof=await db.getProfile(user.id).catch(()=>null);
                                const confirmSender=prof?.company_name||"My Daily Reports";
                                const timeLabel=rq.flexible_display==="flexible"?"Flexible — anytime":(rq.inspection_time||"").substring(0,5);
                                const durMin=parseInt(rq.duration)||60;
                                const durLabel=durMin>=480?"All Day":durMin>=60?(durMin/60)+" hr":durMin+" min";
                                // Build .ics calendar attachment for requester
                                const icsDate=(rq.requested_date||rq.inspection_date||"").replace(/-/g,"");
                                const icsTime=rq.flexible_display!=="flexible"&&rq.inspection_time?(rq.inspection_time.replace(/:/g,"").substring(0,4)+"00"):"";
                                const icsEndMin=icsTime?((parseInt(rq.inspection_time.split(":")[0])*60+parseInt(rq.inspection_time.split(":")[1]))+durMin):0;
                                const icsEnd=icsTime?(String(Math.floor(icsEndMin/60)).padStart(2,"0")+String(icsEndMin%60).padStart(2,"0")+"00"):"";
                                const icsUid=rq.id+"@mydailyreports.org";
                                const icsNow=new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"");
                                const projLabel=(rq.jobs?.name||(rq.project||"").replace(/-/g," ")||"Job");
                                const typeStr=(Array.isArray(rq.inspection_types)?rq.inspection_types.join(", "):rq.inspection_type)||"Visit";
                                let icsContent="BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//My Daily Reports//Scheduling//EN\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\nUID:"+icsUid+"\r\nDTSTAMP:"+icsNow+"\r\n";
                                if(icsTime){icsContent+="DTSTART:"+icsDate+"T"+icsTime+"\r\nDTEND:"+icsDate+"T"+icsEnd+"\r\n";}
                                else{icsContent+="DTSTART;VALUE=DATE:"+icsDate+"\r\n";}
                                icsContent+="SUMMARY:"+typeStr+": "+projLabel+"\r\nDESCRIPTION:Confirmed by "+inspectorName+"\\nDuration: "+durLabel+"\\nTime: "+timeLabel+"\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\nEND:VCALENDAR";
                                await api.sendReport({to:[rq.requester_email],sender_name:confirmSender,subject:`Visit Confirmed — ${projLabel} on ${reqDate}`,
                                  html_body:`<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;"><div style="background:#22c55e;padding:20px 24px;border-radius:8px 8px 0 0;"><h1 style="color:#fff;margin:0;font-size:20px;">Visit Confirmed</h1></div><div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;"><p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 8px;">Hi ${rq.requester_name||"there"},</p><p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 16px;">Your scheduling request for <strong>${projLabel}</strong> has been confirmed by ${inspectorName} for <strong>${reqDate}</strong> at <strong>${timeLabel}</strong>.</p><p style="color:#555;font-size:14px;margin:0;">Type: ${typeStr} | Duration: ${durLabel}</p></div><p style="color:#999;font-size:11px;text-align:center;margin-top:16px;">Sent via My Daily Reports &bull; mydailyreports.org</p></div>`,
                                  ics_attachment:icsContent
                                });
                              }
                              await loadRequests();
                            }catch(er){showToast("Error — try again");btn.disabled=false;btn.style.opacity="1";}}} style={{flex:1,padding:"7px 0",fontSize:12,fontWeight:700,borderRadius:6,background:"#22c55e",border:"none",color:"#fff",cursor:"pointer"}}>
                              Confirm Schedule
                            </button>
                          )}
                          <button onClick={(e)=>{e.stopPropagation();setEditReq(rq);setEditReqDate(rq.requested_date||"");setEditReqTime((rq.inspection_time||"").substring(0,5));}} style={{padding:"7px 12px",fontSize:12,fontWeight:700,borderRadius:6,background:"transparent",border:`1px solid ${C.blu}`,color:C.blu,cursor:"pointer"}}>
                            Edit
                          </button>
                          <button onClick={async(e)=>{e.stopPropagation();if(!window.confirm("Delete this request?"))return;const btn=e.currentTarget;btn.disabled=true;btn.textContent="...";try{await api.updateInspection.delete({request_id:rq.id,action_by:user?.user_metadata?.full_name||user?.email||"Admin"});showToast("Deleted");await loadRequests();}catch(er){console.error("Delete error:",er);showToast("Error: "+er.message);btn.disabled=false;btn.textContent="Delete";}}} style={{padding:"7px 12px",fontSize:12,fontWeight:700,borderRadius:6,background:"transparent",border:`1px solid #ef4444`,color:"#ef4444",cursor:"pointer"}}>
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
              {/* Bottom status */}
              {!selCalDay&&(
                <div style={{padding:"12px 16px",borderTop:`1px solid ${C.brd}`}}>
                  {calRequests.length>0?(
                    <div style={{fontSize:12,color:C.mut,lineHeight:1.5}}>
                      <span style={{display:"inline-flex",alignItems:"center",gap:4,marginRight:10}}><span style={{width:6,height:6,borderRadius:"50%",background:C.err,display:"inline-block"}}/> Blocked</span>
                      <span style={{display:"inline-flex",alignItems:"center",gap:4,marginRight:10}}><span style={{width:6,height:6,borderRadius:"50%",background:C.org,display:"inline-block"}}/> Pending</span>
                      <span style={{display:"inline-flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:"#22c55e",display:"inline-block"}}/> Scheduled</span>
                      <span style={{marginLeft:10}}>· {calRequests.length} request{calRequests.length!==1?"s":""} this month</span>
                    </div>
                  ):hasScheduling?(
                    <div style={{fontSize:12,color:C.mut,lineHeight:1.5}}>No scheduling requests this month. Calendar active for {act.filter(j=>j.scheduling_enabled).length} job{act.filter(j=>j.scheduling_enabled).length!==1?"s":""}.</div>
                  ):(
                    <div style={{fontSize:12,color:C.mut,lineHeight:1.5}}>Enable Jobsite Scheduling on a job to let your GC and subs request site visits through your shared calendar.</div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Edit Request Modal ── */}
        {editReq&&(
          <div onClick={()=>{if(!editReqSaving)setEditReq(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:99999,padding:20}}>
            <div onClick={e=>e.stopPropagation()} style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:14,padding:"24px 20px",maxWidth:360,width:"100%"}}>
              <div style={{fontSize:16,fontWeight:700,color:C.txt,marginBottom:4}}>Edit Request</div>
              <div style={{fontSize:12,color:C.mut,marginBottom:16}}>{editReq.jobs?.name||"Job"} — {editReq.requester_name||editReq.submitted_by||""}</div>
              <div style={{marginBottom:12}}>
                <div style={{fontSize:12,fontWeight:600,color:C.lt,marginBottom:4}}>Date</div>
                <input type="date" value={editReqDate} onChange={e=>setEditReqDate(e.target.value)} style={{width:"100%",padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:14}}/>
              </div>
              <div style={{marginBottom:20}}>
                <div style={{fontSize:12,fontWeight:600,color:C.lt,marginBottom:4}}>Time</div>
                <input type="time" value={editReqTime} onChange={e=>setEditReqTime(e.target.value)} style={{width:"100%",padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:14}}/>
              </div>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>setEditReq(null)} disabled={editReqSaving} style={{flex:1,padding:"12px 0",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,fontSize:14,fontWeight:600,cursor:"pointer"}}>Cancel</button>
                <button onClick={async()=>{
                  if(!editReqDate||!editReqTime){showToast("Pick a date and time");return;}
                  setEditReqSaving(true);
                  try{
                    await api.updateInspection.edit({request_id:editReq.id,action_by:user?.user_metadata?.full_name||user?.email||"Admin",new_date:editReqDate,new_time:editReqTime+":00"});
                    await loadRequests();
                    setEditReq(null);
                    setSelCalDay(editReqDate);
                    showToast("Request updated");
                  }catch(er){showToast("Error — try again");}
                  finally{setEditReqSaving(false);}
                }} disabled={editReqSaving} style={{flex:1,padding:"12px 0",background:C.blu,border:"none",borderRadius:8,color:"#fff",fontSize:14,fontWeight:700,cursor:editReqSaving?"default":"pointer",opacity:editReqSaving?0.6:1}}>{editReqSaving?"Saving...":"Save"}</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Subscribe to Calendar section ── */}
        {showSubDash&&(()=>{
          const slug=profileSlug||user?.user_metadata?.full_name?.toLowerCase().replace(/\s+/g,"-")||"inspector";
          const calURL=`${window.location.origin}${window.location.pathname.replace(/index\.html$/,"").replace(/\/$/,"")}/hub.html?i=${slug}`;
          const icsURL=`${SB_URL}/functions/v1/calendar-feed?slug=${slug}${calendarToken?"&token="+calendarToken:""}`;
          return(
            <div style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,overflow:"hidden",marginBottom:12,position:"relative"}}>
              <button onClick={()=>setShowSubDash(false)} style={{position:"absolute",top:10,right:10,background:C.inp,border:`1px solid ${C.brd}`,color:C.txt,width:28,height:28,borderRadius:"50%",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>&times;</button>
              <div style={{padding:"16px 16px 4px",textAlign:"center"}}>
                <div style={{color:C.blu,fontWeight:600,fontSize:14}}>Share Your Calendar</div>
                <div style={{color:C.mut,fontSize:12,marginTop:4}}>Share your scheduling calendar link or subscribe on your devices</div>
              </div>
              <div style={{padding:"8px 16px"}}>
                <div style={{fontSize:12,fontWeight:700,color:C.org,marginBottom:6}}>Calendar Share Link</div>
                <div style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:6,padding:"10px 12px",display:"flex",alignItems:"center",gap:8}}>
                  <div style={{flex:1,fontSize:12,color:C.lt,wordBreak:"break-all",lineHeight:1.4}}>{calURL}</div>
                  <button onClick={async(e)=>{const btn=e.currentTarget;try{await navigator.clipboard.writeText(calURL);btn.textContent="Copied!";btn.style.background="#22c55e";setTimeout(()=>{btn.textContent="Copy";btn.style.background=C.blu;},3000);}catch(err){showToast("Couldn't copy — long-press the link");}}} style={{background:C.blu,color:"#fff",border:"none",borderRadius:4,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",minWidth:52}}>Copy</button>
                </div>
                <div style={{fontSize:11,color:C.mut,marginTop:6,marginBottom:8}}>Send this link to your GC and subs so they can request site visits.</div>
              </div>
              <div style={{padding:"12px 16px"}}>
                <div style={{fontSize:12,fontWeight:700,color:C.org,marginBottom:6}}>Subscribe on Your Device</div>
                <div style={{fontSize:11,color:C.mut,marginBottom:8}}>Use this subscription URL to sync your calendar to iPhone, Android, or Outlook.</div>
                <div style={{background:C.inp,border:`1px solid ${C.brd}`,borderRadius:6,padding:"10px 12px",marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                  <div style={{flex:1,fontSize:12,color:C.lt,wordBreak:"break-all",lineHeight:1.4,fontFamily:"monospace"}}>{icsURL}</div>
                  <button onClick={async(e)=>{const btn=e.currentTarget;try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(icsURL);}else{const ta=document.createElement("textarea");ta.value=icsURL;ta.style.cssText="position:fixed;opacity:0";document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);}btn.textContent="Copied!";btn.style.background="#22c55e";setTimeout(()=>{btn.textContent="Copy";btn.style.background=C.blu;},3000);}catch(err){showToast("Couldn't copy — long-press the link");}}} style={{background:C.blu,color:"#fff",border:"none",borderRadius:4,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",minWidth:52}}>Copy</button>
                </div>
                <details style={{borderTop:`1px solid ${C.brd}`,padding:"10px 0 0"}}><summary style={{fontSize:13,fontWeight:600,color:C.txt,cursor:"pointer",listStyle:"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>iPhone Setup <span style={{fontSize:14,color:C.lt}}>+</span></summary><div style={{padding:"8px 0",fontSize:13,color:C.lt,lineHeight:1.6}}>1. Settings → Calendar → Accounts<br/>2. "Add Account" → "Other"<br/>3. "Add Subscribed Calendar"<br/>4. Paste the URL above<br/>5. Done!</div></details>
                <details style={{borderTop:`1px solid ${C.brd}`,padding:"10px 0 0"}}><summary style={{fontSize:13,fontWeight:600,color:C.txt,cursor:"pointer",listStyle:"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>Android / Google Calendar <span style={{fontSize:14,color:C.lt}}>+</span></summary><div style={{padding:"8px 0",fontSize:13,color:C.lt,lineHeight:1.6}}>1. Open Google Calendar on desktop<br/>2. Next to "Other calendars," click (+)<br/>3. Select "From URL"<br/>4. Paste the URL above</div></details>
                <details style={{borderTop:`1px solid ${C.brd}`,padding:"10px 0 0"}}><summary style={{fontSize:13,fontWeight:600,color:C.txt,cursor:"pointer",listStyle:"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>Outlook Desktop <span style={{fontSize:14,color:C.lt}}>+</span></summary><div style={{padding:"8px 0",fontSize:13,color:C.lt,lineHeight:1.6}}>1. Open Outlook → Calendar view<br/>2. Click "Add Calendar" → "From Internet"<br/>3. Paste the URL above<br/>4. Click "OK" and name the calendar</div></details>
                <details style={{borderTop:`1px solid ${C.brd}`,padding:"10px 0 0"}}><summary style={{fontSize:13,fontWeight:600,color:C.txt,cursor:"pointer",listStyle:"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>Outlook Mobile <span style={{fontSize:14,color:C.lt}}>+</span></summary><div style={{padding:"8px 0",fontSize:13,color:C.lt,lineHeight:1.6}}>1. Open Outlook app → tap the calendar icon<br/>2. Tap the gear icon (Settings)<br/>3. Tap your account → "Add Shared Calendar"<br/>4. Select "Add from link" or "Subscribe"<br/>5. Paste the URL above and save</div></details>
              </div>
            </div>
          );
        })()}

        {/* ── Bottom tiles — two column ── */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:4}}>
          <button onClick={()=>setShowArch(true)} style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:14,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:8,textAlign:"center"}}>
            <div style={{width:40,height:40,borderRadius:8,background:C.inp,border:`1px solid ${C.brd}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>📁</div>
            <div><div style={{fontWeight:600,fontSize:13,color:C.txt}}>Archived Jobs</div>{arch.length>0&&<div style={{fontSize:11,color:C.mut}}>{arch.length} job{arch.length!==1?"s":""}</div>}</div>
          </button>
          <button onClick={()=>setShowTrain(true)} style={{background:C.card,border:`1px solid ${C.brd}`,borderRadius:12,padding:14,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:8,textAlign:"center"}}>
            <div style={{width:40,height:40,borderRadius:8,background:C.inp,border:`1px solid ${C.brd}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>🎓</div>
            <div><div style={{fontWeight:600,fontSize:13,color:C.txt}}>Training Center</div><div style={{fontSize:11,color:C.mut}}>Guides & tips</div></div>
          </button>
        </div>
      </div>

      <div style={{textAlign:"center",padding:"24px 20px 32px",color:C.mut,fontSize:12}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:12}}>
          <img src="logo.jpg" alt="My Daily Reports" style={{width:28,height:28,borderRadius:6,objectFit:"contain"}}/>
          <span style={{fontSize:11,fontWeight:600,letterSpacing:0.5,color:C.mut}}>My Daily Reports</span>
        </div>
        <a href="#" onClick={e=>{e.preventDefault();setShowFairUse(true);}} style={{color:C.mut,textDecoration:"none"}}>Fair Use Agreement</a>
        <br/><br/>
        <a href="#" onClick={e=>{e.preventDefault();setShowTos(true);}} style={{color:C.mut,textDecoration:"none"}}>Terms of Service</a>
        <span style={{margin:"0 8px"}}>•</span>
        <a href="#" onClick={e=>{e.preventDefault();setShowPriv(true);}} style={{color:C.mut,textDecoration:"none"}}>Privacy Policy</a>
      </div>
    </div>
  );
}


export default Dashboard;
