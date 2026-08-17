import React, { useState, useEffect, useCallback } from 'react';
import { BackIcon } from './icons/UIIcons';

interface JobMatch {
    id: string;
    runDate: string;
    rank: number;
    title: string;
    company: string;
    location: string | null;
    country: string | null;
    source: string | null;
    url: string | null;
    description: string | null;
    matchScore: number | null;
    matchReason: string | null;
    tailoredCv: string | null;
    cvVariant?: string | null;
    status?: string | null;
}

interface JobContact {
    id: string;
    jobMatchId: string;
    contactRole: 'hr' | 'hiring_manager' | 'department_head';
    fullName: string;
    title: string | null;
    linkedinUrl: string | null;
    evidenceUrl: string | null;
    evidenceNote: string | null;
    email: string | null;
    emailSource: string | null;
    emailStatus: 'verified' | 'unverified' | 'listed_in_posting' | 'not_found';
    evidenceStatus?: 'ok' | 'stale';
    checkedAt: string | null;
}

const CONTACT_ROLE_LABEL: Record<JobContact['contactRole'], string> = {
    hr: 'HR / Recruiter',
    hiring_manager: 'Hiring Manager',
    department_head: 'Department Head',
};

const EMAIL_STATUS_BADGE: Record<JobContact['emailStatus'], { label: string; cls: string }> = {
    verified: { label: 'Verified email', cls: 'bg-green-900/40 text-green-300 border-green-500/30' },
    listed_in_posting: { label: 'From job posting', cls: 'bg-green-900/40 text-green-300 border-green-500/30' },
    unverified: { label: 'Unverified — use with caution', cls: 'bg-yellow-900/40 text-yellow-300 border-yellow-500/30' },
    not_found: { label: 'No email found', cls: 'bg-gray-800 text-gray-400 border-gray-600/40' },
};

interface JobQuestion {
    id: string;
    jobMatchId: string;
    question: string;
    answer: string | null;
}

interface Application {
    id: string;
    jobMatchId: string;
    channel: 'email' | 'assisted' | string;
    state: 'queued' | 'route_resolved' | 'ready_for_review' | 'approved' | 'submitting' | 'submitted' | 'needs_user' | 'failed' | string;
    applyUrl: string | null;
    atsType: string | null;
    routeSource: 'official' | 'source_fallback' | null;
    routeConfidence: string | null;
    emailTo: string | null;
    emailToStatus: string | null;
    emailSubject: string | null;
    emailBody: string | null;
    packet: { applyUrl: string; answers: { label: string; value: string }[]; coverNote: string | null; missing: string[] } | null;
    needsUserReason: string | null;
    errorReason: string | null;
    submittedAt: string | null;
}

interface ApplySummary {
    total: number; submitted: number; unconfirmed: number; awaitingReview: number; needsUser: number; failed: number; inProgress: number; notStarted: number;
}

interface HandoffMeta { id: string; applicationId: string; reason: string; expiresAt: number }

/** Live remote view for a CAPTCHA hand-off: frame polling + input forwarding. */
const HandoffViewer: React.FC<{ handoff: HandoffMeta; onClose: () => void }> = ({ handoff, onClose }) => {
    const [frameTs, setFrameTs] = useState(Date.now());
    const [typed, setTyped] = useState('');
    const [gone, setGone] = useState(false);
    const imgRef = React.useRef<HTMLImageElement>(null);
    const errCount = React.useRef(0);

    useEffect(() => {
        const t = setInterval(() => setFrameTs(Date.now()), 1500);
        return () => clearInterval(t);
    }, []);

    const sendInput = async (input: any) => {
        try {
            await fetch(`/api/handoffs/${handoff.id}/input`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
            });
            setFrameTs(Date.now());
        } catch { /* noop */ }
    };

    const handleClick = (e: React.MouseEvent<HTMLImageElement>) => {
        const img = imgRef.current;
        if (!img) return;
        const rect = img.getBoundingClientRect();
        // Browser viewport is 1366x900 (see launchHardenedSession)
        const x = Math.round(((e.clientX - rect.left) / rect.width) * 1366);
        const y = Math.round(((e.clientY - rect.top) / rect.height) * 900);
        sendInput({ type: 'click', x, y });
    };

    const resolve = async (resolution: 'solved' | 'aborted') => {
        try {
            await fetch(`/api/handoffs/${handoff.id}/resolve`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution }),
            });
        } catch { /* noop */ }
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
            <div className="bg-gray-950 border border-amber-500/40 rounded-lg max-w-4xl w-full max-h-[92vh] overflow-y-auto p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                    <h3 className="font-exo text-lg text-amber-300">Live browser — solve the puzzle</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
                </div>
                <p className="text-xs text-gray-400">{handoff.reason} Click directly on the page below; keys and typed text are forwarded to the real browser session.</p>
                {gone ? (
                    <p className="text-sm text-amber-300 p-4">This hand-off session has ended (solved, cancelled, or timed out).</p>
                ) : (
                    <img
                        ref={imgRef}
                        src={`/api/handoffs/${handoff.id}/frame?t=${frameTs}`}
                        onError={() => { errCount.current += 1; if (errCount.current >= 3) setGone(true); }}
                        onLoad={() => { errCount.current = 0; }}
                        onClick={handleClick}
                        alt="Live browser session"
                        className="w-full border border-amber-500/30 rounded cursor-crosshair select-none"
                        draggable={false}
                    />
                )}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <input
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && typed) { sendInput({ type: 'type', text: typed }); setTyped(''); } }}
                        placeholder="Type text, press Enter to send it to the page"
                        className="flex-1 min-w-[200px] px-3 py-2 bg-gray-900/70 border border-amber-500/30 rounded text-white focus:outline-none focus:border-amber-400"
                    />
                    {['Enter', 'Tab', 'Escape'].map((k) => (
                        <button key={k} onClick={() => sendInput({ type: 'press', key: k })} className="px-2 py-1 border border-gray-600 rounded text-gray-300 hover:text-white">{k}</button>
                    ))}
                    <button onClick={() => sendInput({ type: 'scroll', deltaY: 400 })} className="px-2 py-1 border border-gray-600 rounded text-gray-300 hover:text-white">Scroll ↓</button>
                    <button onClick={() => sendInput({ type: 'scroll', deltaY: -400 })} className="px-2 py-1 border border-gray-600 rounded text-gray-300 hover:text-white">Scroll ↑</button>
                </div>
                <div className="flex items-center gap-3 pt-2">
                    <button onClick={() => resolve('solved')} className="px-4 py-2 text-sm font-bold text-slate-900 bg-green-400 hover:bg-green-300 rounded-lg font-exo">I solved it — continue automation</button>
                    <button onClick={() => resolve('aborted')} className="px-4 py-2 text-sm text-red-300 border border-red-500/40 rounded-lg hover:bg-red-900/30">Cancel this run</button>
                    <span className="ml-auto text-[10px] text-gray-500">Expires {new Date(handoff.expiresAt).toLocaleTimeString()}</span>
                </div>
            </div>
        </div>
    );
};

const APP_STATE_BADGE: Record<string, { label: string; cls: string }> = {
    queued: { label: 'Apply: queued', cls: 'bg-gray-800 text-gray-300 border-gray-600/40' },
    route_resolved: { label: 'Apply: route found', cls: 'bg-cyan-900/40 text-cyan-300 border-cyan-500/30' },
    ready_for_review: { label: 'Apply: awaiting your review', cls: 'bg-amber-900/40 text-amber-300 border-amber-500/30' },
    approved: { label: 'Apply: approved', cls: 'bg-cyan-900/40 text-cyan-300 border-cyan-500/30' },
    submitting: { label: 'Apply: submitting…', cls: 'bg-cyan-900/40 text-cyan-300 border-cyan-500/30' },
    submitted: { label: 'Applied ✓', cls: 'bg-green-900/40 text-green-300 border-green-500/30' },
    submitted_unconfirmed: { label: 'Applied (unconfirmed)', cls: 'bg-lime-900/40 text-lime-300 border-lime-500/30' },
    needs_user: { label: 'Apply: needs your input', cls: 'bg-red-900/40 text-red-300 border-red-500/30' },
    failed: { label: 'Apply: failed', cls: 'bg-red-900/40 text-red-300 border-red-500/30' },
};

interface JobOpportunitiesProps {
    onBack: () => void;
}

const JobOpportunities: React.FC<JobOpportunitiesProps> = ({ onBack }) => {
    const [dates, setDates] = useState<string[]>([]);
    const [selectedDate, setSelectedDate] = useState<string>('');
    const [jobs, setJobs] = useState<JobMatch[]>([]);
    const [loading, setLoading] = useState(false);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tailoringId, setTailoringId] = useState<string | null>(null);
    const [viewingCv, setViewingCv] = useState<JobMatch | null>(null);
    const [boardAlerts, setBoardAlerts] = useState<string[]>([]);
    const [googleDiscoveryError, setGoogleDiscoveryError] = useState<{ error: string; timestamp: string } | null>(null);
    const [questions, setQuestions] = useState<Record<string, JobQuestion[]>>({});
    const [contacts, setContacts] = useState<Record<string, JobContact[]>>({});
    const [contactRunResults, setContactRunResults] = useState<Record<string, { summary: string; checkedAt: string }>>({});
    const [findingContactsId, setFindingContactsId] = useState<string | null>(null);

    const [apps, setApps] = useState<Record<string, Application[]>>({});
    const [applySummary, setApplySummary] = useState<ApplySummary | null>(null);
    const [preparingId, setPreparingId] = useState<string | null>(null);
    const [approvingId, setApprovingId] = useState<string | null>(null);
    const [reviewingApp, setReviewingApp] = useState<Application | null>(null);
    const [emailEdits, setEmailEdits] = useState<{ subject: string; body: string }>({ subject: '', body: '' });
    const [screenshots, setScreenshots] = useState<Record<string, { id: string; kind: string; createdAt: string | null }[]>>({});
    const [viewingShot, setViewingShot] = useState<{ appId: string; shotId: string; kind: string } | null>(null);
    const [handoffs, setHandoffs] = useState<HandoffMeta[]>([]);
    const [viewingHandoff, setViewingHandoff] = useState<HandoffMeta | null>(null);
    const [verifyLinks, setVerifyLinks] = useState<Record<string, string>>({});
    const [savingLinkId, setSavingLinkId] = useState<string | null>(null);

    // Poll for live CAPTCHA hand-off sessions (cheap; only while page is open)
    useEffect(() => {
        let stop = false;
        const poll = async () => {
            try {
                const res = await fetch('/api/handoffs');
                if (res.ok && !stop) setHandoffs(await res.json());
            } catch { /* noop */ }
        };
        poll();
        const t = setInterval(poll, 8000);
        return () => { stop = true; clearInterval(t); };
    }, []);

    const handleSaveVerifyLink = async (app: Application) => {
        const link = (verifyLinks[app.id] || '').trim();
        if (!link) return;
        setSavingLinkId(app.id);
        setError(null);
        try {
            const res = await fetch(`/api/applications/${app.id}/verification-link`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || 'Failed to save link');
            setVerifyLinks((prev) => ({ ...prev, [app.id]: '' }));
            // Immediately retry preparation with the pasted link
            const job = jobs.find((j) => j.id === app.jobMatchId);
            if (job) await handlePrepareApply(job);
        } catch (e: any) {
            setError(e.message || 'Failed to save verification link');
        } finally {
            setSavingLinkId(null);
        }
    };

    // Load screenshot metadata for headless-apply applications (once per app id)
    useEffect(() => {
        const atsApps = Object.values(apps).flat().filter((a) => a.channel === 'ats_auto' && !(a.id in screenshots));
        if (atsApps.length === 0) return;
        atsApps.forEach(async (a) => {
            try {
                const res = await fetch(`/api/applications/${a.id}/screenshots`);
                setScreenshots((prev) => ({ ...prev, [a.id]: res.ok ? [] : [] }));
                if (res.ok) {
                    const meta = await res.json();
                    setScreenshots((prev) => ({ ...prev, [a.id]: meta }));
                }
            } catch { setScreenshots((prev) => ({ ...prev, [a.id]: [] })); }
        });
    }, [apps, screenshots]);

    const SHOT_LABEL: Record<string, string> = { pre_submit: 'Pre-submit screenshot', confirmation: 'Confirmation screenshot', failure: 'Screenshot at pause' };

    const loadApplications = useCallback(async (jobIds: string[], date: string) => {
        try {
            const [appsRes, sumRes] = await Promise.all([
                fetch('/api/applications/for-jobs', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobIds }),
                }),
                date ? fetch(`/api/applications/summary?date=${encodeURIComponent(date)}`) : Promise.resolve(null as any),
            ]);
            if (appsRes.ok) setApps(await appsRes.json());
            if (sumRes && sumRes.ok) setApplySummary(await sumRes.json());
        } catch { /* noop */ }
    }, []);

    const handlePrepareApply = async (job: JobMatch) => {
        setPreparingId(job.id);
        setError(null);
        try {
            const res = await fetch(`/api/jobs/${job.id}/apply/prepare`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || 'Application preparation failed');
            setApps((prev) => ({ ...prev, [job.id]: [data, ...(prev[job.id] || []).filter((a) => a.id !== data.id)] }));
        } catch (e: any) {
            setError(e.message || 'Application preparation failed');
        } finally {
            setPreparingId(null);
        }
    };

    const handleApprove = async (application: Application, edits?: { emailSubject?: string; emailBody?: string }) => {
        setApprovingId(application.id);
        setError(null);
        try {
            const res = await fetch(`/api/applications/${application.id}/approve`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(edits || {}),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || 'Approval failed');
            setApps((prev) => ({ ...prev, [application.jobMatchId]: (prev[application.jobMatchId] || []).map((a) => (a.id === data.id ? data : a)) }));
            // Force screenshot metadata refresh (a submission run adds new screenshots)
            setScreenshots((prev) => { const { [application.id]: _gone, ...rest } = prev; return rest; });
            setReviewingApp(null);
        } catch (e: any) {
            setError(e.message || 'Approval failed');
        } finally {
            setApprovingId(null);
        }
    };

    const loadContacts = useCallback(async (jobIds: string[]) => {
        const entries = await Promise.all(jobIds.map(async (id) => {
            try {
                const res = await fetch(`/api/jobs/${id}/contacts`);
                return [id, res.ok ? await res.json() : []] as const;
            } catch { return [id, []] as const; }
        }));
        setContacts(Object.fromEntries(entries));
    }, []);

    const handleFindContacts = async (job: JobMatch) => {
        setFindingContactsId(job.id);
        setError(null);
        try {
            const res = await fetch(`/api/jobs/${job.id}/find-contacts`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error((data as any).message || 'Contact discovery failed');
            // Response shape: { contacts: JobContact[], summary: string, checkedAt: string }
            const contactList: JobContact[] = Array.isArray(data.contacts) ? data.contacts : data;
            setContacts((prev) => ({ ...prev, [job.id]: contactList }));
            if (data.summary) {
                setContactRunResults((prev) => ({
                    ...prev,
                    [job.id]: { summary: data.summary, checkedAt: data.checkedAt || new Date().toISOString() },
                }));
            }
        } catch (e: any) {
            setError(e.message || 'Contact discovery failed');
        } finally {
            setFindingContactsId(null);
        }
    };
    const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});

    const loadQuestions = useCallback(async (jobIds: string[]) => {
        const entries = await Promise.all(jobIds.map(async (id) => {
            try {
                const res = await fetch(`/api/jobs/${id}/questions`);
                return [id, res.ok ? await res.json() : []] as const;
            } catch { return [id, []] as const; }
        }));
        setQuestions(Object.fromEntries(entries));
    }, []);

    const submitAnswer = async (q: JobQuestion) => {
        const answer = (answerDrafts[q.id] || '').trim();
        if (!answer) return;
        try {
            const res = await fetch(`/api/jobs/questions/${q.id}/answer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ answer }),
            });
            if (res.ok) {
                const updated = await res.json();
                setQuestions((prev) => ({
                    ...prev,
                    [q.jobMatchId]: (prev[q.jobMatchId] || []).map((x) => (x.id === q.id ? updated : x)),
                }));
            }
        } catch { /* noop */ }
    };

    const loadDates = useCallback(async () => {
        try {
            const res = await fetch('/api/jobs/dates');
            if (res.ok) {
                const d: string[] = await res.json();
                setDates(d);
                if (d.length > 0) setSelectedDate((prev) => prev || d[0]);
            }
        } catch { /* noop */ }
    }, []);

    const loadJobs = useCallback(async (date: string) => {
        if (!date) return;
        setLoading(true);
        setError(null);
        try {
            const [jobsRes, alertsRes] = await Promise.all([
                fetch(`/api/jobs?date=${encodeURIComponent(date)}`),
                fetch(`/api/jobs/board-alerts?date=${encodeURIComponent(date)}`),
            ]);
            if (!jobsRes.ok) throw new Error('Failed to load shortlist');
            setJobs(await jobsRes.json());
            if (alertsRes.ok) {
                const alertData = await alertsRes.json();
                setBoardAlerts(Array.isArray(alertData.alerts) ? alertData.alerts : []);
                setGoogleDiscoveryError(alertData.googleDiscoveryStatus ?? null);
            } else {
                setBoardAlerts([]);
                setGoogleDiscoveryError(null);
            }
        } catch (e: any) {
            setError(e.message || 'Failed to load jobs');
        } finally {
            setLoading(false);
        }
    }, []);

    // Fetch Google discovery status independently of a saved shortlist date so the
    // warning is visible even when no shortlist exists yet (e.g. first-run or
    // after a failed search).
    const loadGoogleStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/jobs/google-discovery-status');
            if (res.ok) {
                const data = await res.json();
                // Only overwrite if loadJobs hasn't already set a more recent value
                setGoogleDiscoveryError((prev) => prev ?? (data.googleDiscoveryStatus ?? null));
            }
        } catch { /* noop */ }
    }, []);

    useEffect(() => { loadDates(); loadGoogleStatus(); }, [loadDates, loadGoogleStatus]);
    useEffect(() => { if (selectedDate) loadJobs(selectedDate); }, [selectedDate, loadJobs]);
    useEffect(() => { if (jobs.length) { loadQuestions(jobs.map((j) => j.id)); loadContacts(jobs.map((j) => j.id)); loadApplications(jobs.map((j) => j.id), selectedDate); } }, [jobs, selectedDate, loadQuestions, loadContacts, loadApplications]);

    const handleRunNow = async () => {
        setRunning(true);
        setError(null);
        try {
            const res = await fetch('/api/jobs/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force: false }),
            });
            const data = await res.json().catch(() => ({}));
            // Extract board alerts and Google discovery status from both success and error responses
            if (Array.isArray(data.boardAlerts) && data.boardAlerts.length > 0) {
                setBoardAlerts(data.boardAlerts);
            }
            if (data.googleDiscoveryStatus !== undefined) {
                setGoogleDiscoveryError(data.googleDiscoveryStatus ?? null);
            }
            if (!res.ok) throw new Error(data.message || 'Job search failed');
            await loadDates();
            setSelectedDate(data.runDate);
            await loadJobs(data.runDate);
        } catch (e: any) {
            setError(e.message || 'Job search failed');
        } finally {
            setRunning(false);
        }
    };

    const handleTailorCv = async (job: JobMatch, force = false) => {
        if (job.tailoredCv && !force) {
            setViewingCv(job);
            return;
        }
        setTailoringId(job.id);
        setError(null);
        try {
            const res = await fetch(`/api/jobs/${job.id}/tailor-cv`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || 'CV tailoring failed');
            setJobs((prev) => prev.map((j) => (j.id === job.id ? data : j)));
            setViewingCv(data);
        } catch (e: any) {
            setError(e.message || 'CV tailoring failed');
        } finally {
            setTailoringId(null);
        }
    };

    const [pdfLoading, setPdfLoading] = useState(false);

    const downloadCvPdf = async (job: JobMatch) => {
        if (!job.tailoredCv || pdfLoading) return;
        setPdfLoading(true);
        try {
            const res = await fetch(`/api/jobs/${job.id}/cv.pdf`);
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || 'PDF generation failed');
            }
            const blob = await res.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `CV_${job.company.replace(/[^a-z0-9]/gi, '_')}_${job.title.replace(/[^a-z0-9]/gi, '_')}.pdf`;
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (e: any) {
            setError(e.message || 'PDF download failed');
        } finally {
            setPdfLoading(false);
        }
    };

    if (viewingCv) {
        return (
            <div className="h-full flex flex-col p-4 bg-black/30 border border-cyan-500/20 rounded-lg backdrop-blur-md overflow-y-auto animate-fade-in">
                <div className="flex-shrink-0 flex items-center justify-between mb-4">
                    <button onClick={() => setViewingCv(null)} className="flex items-center space-x-2 text-cyan-300 hover:text-white transition-colors">
                        <BackIcon />
                        <span className="font-bold font-exo">Back to Shortlist</span>
                    </button>
                    <button onClick={() => downloadCvPdf(viewingCv)} disabled={pdfLoading} className="px-4 py-2 text-sm font-bold text-slate-900 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 disabled:cursor-not-allowed rounded-lg transition-colors btn-glow font-exo">
                        {pdfLoading ? 'Generating PDF…' : 'Download PDF'}
                    </button>
                </div>
                <h2 className="font-exo text-xl text-white mb-1">Tailored CV — {viewingCv.title}</h2>
                <p className="text-sm text-cyan-300 mb-4">{viewingCv.company} · {viewingCv.location}{viewingCv.country ? `, ${viewingCv.country}` : ''}</p>
                <pre className="whitespace-pre-wrap font-sans text-sm text-gray-200 bg-gray-900/50 border border-cyan-600/20 rounded-lg p-6 leading-relaxed">
                    {viewingCv.tailoredCv}
                </pre>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col p-4 bg-black/30 border border-cyan-500/20 rounded-lg backdrop-blur-md overflow-y-auto animate-fade-in">
            <div className="flex-shrink-0 flex items-center justify-between mb-6">
                <button onClick={onBack} className="flex items-center space-x-2 text-cyan-300 hover:text-white transition-colors">
                    <BackIcon />
                    <span className="font-bold font-exo">Back to Dashboard</span>
                </button>
                <h2 className="font-exo text-2xl text-white">Job Opportunities</h2>
            </div>

            <div className="max-w-4xl mx-auto w-full space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center space-x-3">
                        <label className="text-sm text-gray-400">Shortlist date:</label>
                        <select
                            value={selectedDate}
                            onChange={(e) => setSelectedDate(e.target.value)}
                            className="px-3 py-2 bg-gray-900/70 border border-cyan-500/30 rounded-lg text-white text-sm focus:outline-none"
                        >
                            {dates.length === 0 && <option value="">No shortlists yet</option>}
                            {dates.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                    </div>
                    <button
                        onClick={handleRunNow}
                        disabled={running}
                        className="px-4 py-2 text-sm font-bold text-slate-900 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 rounded-lg transition-colors btn-glow font-exo"
                    >
                        {running ? 'Searching... (2-4 min)' : 'Run Search Now'}
                    </button>
                </div>

                <p className="text-xs text-gray-500">
                    Automatic search runs every day at 7:00 AM (MYT) across LinkedIn, Indeed, JobStreet, Randstad and Hays in Malaysia, New Zealand, Australia, Sweden, Switzerland, Ireland, Poland and Portugal.
                </p>

                {googleDiscoveryError && (
                    <div className="bg-red-900/20 border border-red-500/40 rounded-lg p-3 space-y-1">
                        <p className="text-xs font-bold text-red-400 uppercase tracking-wide">🔴 Google Discovery Unavailable</p>
                        <p className="text-xs text-red-300">Google Custom Search API error: {googleDiscoveryError.error}</p>
                        <p className="text-xs text-red-400">Last failed: {new Date(googleDiscoveryError.timestamp).toLocaleString()}</p>
                        <p className="text-xs text-red-500 mt-1">Regional job URL discovery is degraded. Check that GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID are valid and have remaining quota. Supplemental search will still run but may find fewer targeted leads.</p>
                    </div>
                )}

                {boardAlerts.length > 0 && (
                    <div className="bg-yellow-900/20 border border-yellow-500/40 rounded-lg p-3 space-y-1">
                        <p className="text-xs font-bold text-yellow-400 uppercase tracking-wide">⚠ Board Coverage Warning</p>
                        {boardAlerts.map((alert, i) => (
                            <p key={i} className="text-xs text-yellow-300">{alert}</p>
                        ))}
                        <p className="text-xs text-yellow-500 mt-1">These boards may be blocking searches or returning only listing pages. Results from these sources are missing from today's shortlist.</p>
                    </div>
                )}

                {error && <p className="text-sm text-red-400 bg-red-900/20 border border-red-500/30 rounded-lg p-3">{error}</p>}

                {applySummary && applySummary.total > 0 && (
                    <div className="flex flex-wrap items-center gap-2 text-xs bg-gray-900/50 border border-cyan-600/20 rounded-lg p-3">
                        <span className="font-bold text-cyan-300 uppercase tracking-wide">Applications:</span>
                        <span className="px-2 py-0.5 bg-green-900/40 text-green-300 border border-green-500/30 rounded-full">{applySummary.submitted} submitted</span>
                        {(applySummary.unconfirmed ?? 0) > 0 && <span className="px-2 py-0.5 bg-lime-900/40 text-lime-300 border border-lime-500/30 rounded-full">{applySummary.unconfirmed} unconfirmed — verify</span>}
                        <span className="px-2 py-0.5 bg-amber-900/40 text-amber-300 border border-amber-500/30 rounded-full">{applySummary.awaitingReview} awaiting review</span>
                        <span className="px-2 py-0.5 bg-red-900/40 text-red-300 border border-red-500/30 rounded-full">{applySummary.needsUser} need input</span>
                        {applySummary.failed > 0 && <span className="px-2 py-0.5 bg-red-900/40 text-red-300 border border-red-500/30 rounded-full">{applySummary.failed} failed</span>}
                        <span className="px-2 py-0.5 bg-gray-800 text-gray-400 border border-gray-600/40 rounded-full">{applySummary.notStarted + applySummary.inProgress} not prepared yet</span>
                    </div>
                )}

                {loading ? (
                    <p className="text-gray-400 text-center py-10">Loading shortlist...</p>
                ) : jobs.length === 0 ? (
                    <p className="text-gray-500 text-center py-10">No shortlist for this date yet. Click "Run Search Now" to generate today's list.</p>
                ) : (
                    <div className="space-y-3">
                        {jobs.map((job) => (
                            <div key={job.id} className="p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg">
                                <div className="flex justify-between items-start gap-3">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-xs font-bold text-slate-900 bg-cyan-400 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0">{job.rank}</span>
                                            <h3 className="font-exo text-lg text-white">{job.title}</h3>
                                            {job.matchScore != null && (
                                                <span className="text-xs px-2 py-0.5 bg-green-900/60 border border-green-500/40 text-green-300 rounded-full">{job.matchScore}% match</span>
                                            )}
                                        </div>
                                        <p className="text-sm text-cyan-300 mt-1">
                                            {job.company} · {job.location}{job.country ? `, ${job.country}` : ''}{job.source ? ` · via ${job.source}` : ''}
                                        </p>
                                        {job.description && <p className="text-sm text-gray-400 mt-2">{job.description}</p>}
                                        {job.matchReason && <p className="text-sm text-gray-300 mt-2 italic">Why it fits: {job.matchReason}</p>}
                                        {job.cvVariant && <p className="text-xs text-cyan-400/80 mt-1">CV used: {job.cvVariant}</p>}
                                        {job.status === 'cv_ready' && <span className="inline-block mt-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-green-900/40 text-green-300 border border-green-500/30 rounded-full">CV Ready</span>}
                                        {job.status === 'cv_failed' && <span className="inline-block mt-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-red-900/40 text-red-300 border border-red-500/30 rounded-full">CV Failed — click "Prepare Tailored CV" to retry</span>}
                                        {(!job.status || job.status === 'shortlisted') && <span className="inline-block mt-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-gray-800 text-gray-400 border border-gray-600/40 rounded-full">Shortlisted</span>}
                                        {(questions[job.id] || []).map((q) => (
                                            <div key={q.id} className="mt-2 p-2 bg-amber-900/20 border border-amber-500/30 rounded-lg">
                                                <p className="text-xs text-amber-300">❓ {q.question}</p>
                                                {q.answer ? (
                                                    <div className="mt-1 flex items-center justify-between gap-2">
                                                        <p className="text-xs text-green-300">✓ Answered: {q.answer}</p>
                                                        {job.tailoredCv && (
                                                            <button onClick={() => handleTailorCv(job, true)} disabled={tailoringId === job.id} className="shrink-0 px-2 py-0.5 text-[10px] font-bold text-slate-900 bg-cyan-400 hover:bg-cyan-300 rounded disabled:opacity-50">
                                                                {tailoringId === job.id ? 'Regenerating…' : 'Regenerate CV with this answer'}
                                                            </button>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="flex gap-2 mt-1">
                                                        <input
                                                            type="text"
                                                            value={answerDrafts[q.id] || ''}
                                                            onChange={(e) => setAnswerDrafts((p) => ({ ...p, [q.id]: e.target.value }))}
                                                            placeholder="Your answer…"
                                                            className="flex-1 px-2 py-1 text-xs bg-gray-900/70 border border-amber-500/30 rounded text-white focus:outline-none"
                                                        />
                                                        <button onClick={() => submitAnswer(q)} className="px-2 py-1 text-xs font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded">
                                                            Save
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                {(contacts[job.id] || []).length > 0 ? (
                                    <div className="mt-3 p-3 bg-gray-900/70 border border-purple-500/20 rounded-lg space-y-2">
                                        <p className="text-xs font-bold text-purple-300 uppercase tracking-wide">Contacts</p>
                                        {contactRunResults[job.id] && (
                                            <p className="text-xs text-gray-500 italic">{contactRunResults[job.id].summary}</p>
                                        )}
                                        {(contacts[job.id] || []).map((c) => (
                                            <div key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                                                <span className="px-2 py-0.5 bg-purple-900/40 text-purple-300 border border-purple-500/30 rounded-full">{CONTACT_ROLE_LABEL[c.contactRole] || c.contactRole}</span>
                                                <span className="text-white font-semibold">{c.fullName}</span>
                                                {c.title && <span className="text-gray-400">— {c.title}</span>}
                                                {c.email ? <span className="text-cyan-300 select-all">{c.email}</span> : null}
                                                <span className={`px-2 py-0.5 border rounded-full ${EMAIL_STATUS_BADGE[c.emailStatus]?.cls || ''}`}>{EMAIL_STATUS_BADGE[c.emailStatus]?.label || c.emailStatus}</span>
                                                {c.linkedinUrl && <a href={c.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">LinkedIn</a>}
                                                {c.evidenceUrl && <a href={c.evidenceUrl} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:underline">Source</a>}
                                                {c.evidenceStatus === 'stale' && <span className="px-2 py-0.5 bg-amber-900/40 text-amber-300 border border-amber-500/30 rounded-full">Evidence page gone — verify manually</span>}
                                                {c.evidenceNote && <span className="w-full text-gray-500 italic">{c.evidenceNote}</span>}
                                            </div>
                                        ))}
                                    </div>
                                ) : contactRunResults[job.id] ? (
                                    <div className="mt-3 p-3 bg-gray-900/70 border border-purple-500/20 rounded-lg">
                                        <p className="text-xs font-bold text-purple-300 uppercase tracking-wide">Contacts</p>
                                        <p className="text-xs text-gray-400 mt-1">{contactRunResults[job.id].summary}</p>
                                        <p className="text-xs text-gray-600 mt-1">Checked {new Date(contactRunResults[job.id].checkedAt).toLocaleString()}</p>
                                    </div>
                                ) : null}
                                {(apps[job.id] || []).slice(0, 1).map((a) => (
                                    <div key={a.id} className="mt-3 p-3 bg-gray-900/70 border border-cyan-500/20 rounded-lg space-y-2">
                                        <div className="flex flex-wrap items-center gap-2 text-xs">
                                            <span className="font-bold text-cyan-300 uppercase tracking-wide">Application</span>
                                            <span className={`px-2 py-0.5 border rounded-full ${APP_STATE_BADGE[a.state]?.cls || 'bg-gray-800 text-gray-400 border-gray-600/40'}`}>{APP_STATE_BADGE[a.state]?.label || a.state}</span>
                                            {a.channel && <span className="px-2 py-0.5 bg-gray-800 text-gray-300 border border-gray-600/40 rounded-full">{a.channel === 'email' ? 'Email apply' : a.channel === 'ats_auto' ? 'Auto-apply (ATS)' : 'Assisted apply'}</span>}
                                            {a.atsType && a.atsType !== 'unknown' && <span className="px-2 py-0.5 bg-purple-900/40 text-purple-300 border border-purple-500/30 rounded-full">ATS: {a.atsType}</span>}
                                            {a.routeSource && <span className="px-2 py-0.5 bg-gray-800 text-gray-400 border border-gray-600/40 rounded-full">{a.routeSource === 'official' ? 'Official careers page' : 'Original posting URL'}</span>}
                                        </div>
                                        {a.applyUrl && (
                                            <p className="text-xs text-gray-400 break-all">Apply at: <a href={a.applyUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">{a.applyUrl}</a></p>
                                        )}
                                        {a.state === 'needs_user' && a.needsUserReason && (
                                            <p className="text-xs text-red-300 bg-red-900/20 border border-red-500/30 rounded p-2">{a.needsUserReason}</p>
                                        )}
                                        {a.state === 'needs_user' && /verification (e-?mail|link)/i.test(a.needsUserReason || '') && (
                                            <div className="flex flex-wrap items-center gap-2">
                                                <input
                                                    value={verifyLinks[a.id] || ''}
                                                    onChange={(e) => setVerifyLinks((prev) => ({ ...prev, [a.id]: e.target.value }))}
                                                    placeholder="Paste the verification link from the email here"
                                                    className="flex-1 min-w-[240px] px-3 py-1.5 text-xs bg-gray-900/70 border border-cyan-500/30 rounded text-white focus:outline-none focus:border-cyan-400"
                                                />
                                                <button
                                                    onClick={() => handleSaveVerifyLink(a)}
                                                    disabled={savingLinkId === a.id || !(verifyLinks[a.id] || '').trim()}
                                                    className="px-3 py-1.5 text-xs font-bold text-slate-900 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 rounded-full transition-colors"
                                                >
                                                    {savingLinkId === a.id ? 'Verifying…' : 'Save Link & Continue'}
                                                </button>
                                            </div>
                                        )}
                                        {handoffs.filter((h) => h.applicationId === a.id).map((h) => (
                                            <div key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-amber-300 bg-amber-900/20 border border-amber-500/40 rounded p-2">
                                                <span className="font-bold">⚠ Human verification needed right now.</span>
                                                <span className="text-amber-200/80">{h.reason}</span>
                                                <button onClick={() => setViewingHandoff(h)} className="ml-auto px-3 py-1 font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-full">Open Live View</button>
                                            </div>
                                        ))}
                                        {a.state === 'failed' && a.errorReason && (
                                            <p className="text-xs text-red-300 bg-red-900/20 border border-red-500/30 rounded p-2">Failed: {a.errorReason}</p>
                                        )}
                                        {a.state === 'submitted' && a.submittedAt && (
                                            <p className="text-xs text-green-400">Submitted {new Date(a.submittedAt).toLocaleString()}{a.channel === 'email' && a.emailTo ? ` — email sent to ${a.emailTo}` : ''}</p>
                                        )}
                                        {a.state === 'submitted_unconfirmed' && (
                                            <p className="text-xs text-lime-300 bg-lime-900/20 border border-lime-500/30 rounded p-2">The form was submitted but no confirmation message was detected — check the confirmation screenshot below to verify.</p>
                                        )}
                                        {a.channel === 'ats_auto' && (screenshots[a.id] || []).length > 0 && (
                                            <div className="flex flex-wrap gap-2">
                                                {(screenshots[a.id] || []).map((s) => (
                                                    <button key={s.id} onClick={() => setViewingShot({ appId: a.id, shotId: s.id, kind: s.kind })} className="px-2 py-1 text-xs text-purple-300 border border-purple-400/40 rounded-full hover:bg-purple-900/40 transition-colors">
                                                        {SHOT_LABEL[s.kind] || s.kind} ↗
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        <div className="flex flex-wrap gap-2">
                                            {a.state === 'ready_for_review' && a.channel === 'email' && (
                                                <button
                                                    onClick={() => { setReviewingApp(a); setEmailEdits({ subject: a.emailSubject || '', body: a.emailBody || '' }); }}
                                                    className="px-3 py-1.5 text-xs font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-full transition-colors"
                                                >
                                                    Review Email &amp; Send
                                                </button>
                                            )}
                                            {a.state === 'ready_for_review' && a.channel === 'ats_auto' && (
                                                <button
                                                    onClick={() => setReviewingApp(a)}
                                                    className="px-3 py-1.5 text-xs font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-full transition-colors"
                                                >
                                                    Review Filled Form &amp; Approve
                                                </button>
                                            )}
                                            {a.state === 'ready_for_review' && a.channel === 'assisted' && (
                                                <button
                                                    onClick={() => setReviewingApp(a)}
                                                    className="px-3 py-1.5 text-xs font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-full transition-colors"
                                                >
                                                    Open Apply Packet
                                                </button>
                                            )}
                                            {(a.state === 'needs_user' || a.state === 'failed') && (
                                                <button
                                                    onClick={() => handlePrepareApply(job)}
                                                    disabled={preparingId === job.id}
                                                    className="px-3 py-1.5 text-xs font-bold text-slate-900 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 rounded-full transition-colors"
                                                >
                                                    {preparingId === job.id ? 'Retrying…' : 'Retry Preparation'}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                                <div className="flex flex-wrap gap-2 mt-3">
                                    {(apps[job.id] || []).length === 0 && (
                                        <button
                                            onClick={() => handlePrepareApply(job)}
                                            disabled={preparingId === job.id}
                                            className="px-3 py-1.5 text-xs font-bold text-slate-900 bg-green-400 hover:bg-green-300 disabled:opacity-50 rounded-full transition-colors"
                                        >
                                            {preparingId === job.id ? 'Preparing application… (1-2 min)' : 'Prepare Application'}
                                        </button>
                                    )}
                                    {job.url && (
                                        <a href={job.url} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 text-xs text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors">
                                            View Posting
                                        </a>
                                    )}
                                    <button
                                        onClick={() => handleTailorCv(job)}
                                        disabled={tailoringId === job.id}
                                        className="px-3 py-1.5 text-xs font-bold text-slate-900 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 rounded-full transition-colors"
                                    >
                                        {tailoringId === job.id ? 'Preparing CV...' : job.tailoredCv ? 'View Tailored CV' : 'Prepare Tailored CV'}
                                    </button>
                                    <button
                                        onClick={() => handleFindContacts(job)}
                                        disabled={findingContactsId === job.id}
                                        className="px-3 py-1.5 text-xs font-bold text-slate-900 bg-purple-400 hover:bg-purple-300 disabled:opacity-50 rounded-full transition-colors"
                                    >
                                        {findingContactsId === job.id ? 'Finding contacts... (1-2 min)' : (contacts[job.id] || []).length > 0 ? 'Refresh Contacts' : 'Find HR & Hiring Manager'}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {reviewingApp && (
                <div className="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center p-4" onClick={() => setReviewingApp(null)}>
                    <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto bg-slate-950 border border-cyan-500/40 rounded-lg p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
                        {reviewingApp.channel === 'email' ? (
                            <>
                                <h3 className="font-exo text-xl text-white">Review Application Email</h3>
                                <p className="text-xs text-gray-400">To: <span className="text-cyan-300">{reviewingApp.emailTo}</span>{reviewingApp.emailToStatus ? ` (${reviewingApp.emailToStatus.replace(/_/g, ' ')})` : ''} — your tailored CV PDF will be attached. Nothing is sent until you approve.</p>
                                <div>
                                    <label className="block text-xs text-cyan-300 mb-1">Subject</label>
                                    <input
                                        className="w-full px-3 py-2 bg-gray-900/70 border border-cyan-500/30 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-400"
                                        value={emailEdits.subject}
                                        onChange={(e) => setEmailEdits((p) => ({ ...p, subject: e.target.value }))}
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs text-cyan-300 mb-1">Email body (editable)</label>
                                    <textarea
                                        rows={12}
                                        className="w-full px-3 py-2 bg-gray-900/70 border border-cyan-500/30 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-400 font-sans"
                                        value={emailEdits.body}
                                        onChange={(e) => setEmailEdits((p) => ({ ...p, body: e.target.value }))}
                                    />
                                </div>
                                <div className="flex flex-wrap gap-3 justify-end">
                                    <button onClick={() => setReviewingApp(null)} className="px-4 py-2 text-sm text-gray-300 border border-gray-500/40 rounded-lg hover:bg-gray-800 transition-colors">Cancel</button>
                                    <button
                                        onClick={() => handleApprove(reviewingApp, { emailSubject: emailEdits.subject, emailBody: emailEdits.body })}
                                        disabled={approvingId === reviewingApp.id || !emailEdits.subject.trim() || !emailEdits.body.trim()}
                                        className="px-4 py-2 text-sm font-bold text-slate-900 bg-green-400 hover:bg-green-300 disabled:opacity-50 rounded-lg transition-colors font-exo"
                                    >
                                        {approvingId === reviewingApp.id ? 'Sending…' : 'Approve & Send Email'}
                                    </button>
                                </div>
                            </>
                        ) : reviewingApp.channel === 'ats_auto' ? (
                            <>
                                <h3 className="font-exo text-xl text-white">Review Auto-Filled Application</h3>
                                <p className="text-xs text-gray-400">The form on {reviewingApp.atsType ? `the ${reviewingApp.atsType} page` : 'the ATS page'} was filled with the answers below (see the pre-submit screenshot). Nothing is submitted until you approve.</p>
                                {(screenshots[reviewingApp.id] || []).filter((s) => s.kind === 'pre_submit').slice(-1).map((s) => (
                                    <img key={s.id} src={`/api/applications/${reviewingApp.id}/screenshots/${s.id}`} alt="Pre-submit screenshot of the filled application form" className="w-full border border-cyan-500/30 rounded-lg" />
                                ))}
                                <div className="space-y-1">
                                    {(reviewingApp.packet?.answers || []).map((ans, i) => (
                                        <div key={i} className="flex items-start gap-2 text-sm p-2 bg-gray-900/60 border border-cyan-600/20 rounded">
                                            <span className="text-cyan-300 min-w-[40%] text-xs pt-0.5">{ans.label}</span>
                                            <span className="text-white flex-1">{ans.value}</span>
                                        </div>
                                    ))}
                                </div>
                                <div className="flex flex-wrap gap-3 justify-end">
                                    <button onClick={() => setReviewingApp(null)} className="px-4 py-2 text-sm text-gray-300 border border-gray-500/40 rounded-lg hover:bg-gray-800 transition-colors">Cancel</button>
                                    <button
                                        onClick={() => handleApprove(reviewingApp)}
                                        disabled={approvingId === reviewingApp.id}
                                        className="px-4 py-2 text-sm font-bold text-slate-900 bg-green-400 hover:bg-green-300 disabled:opacity-50 rounded-lg transition-colors font-exo"
                                    >
                                        {approvingId === reviewingApp.id ? 'Submitting… (1-2 min)' : 'Approve & Submit Application'}
                                    </button>
                                </div>
                            </>
                        ) : (
                            <>
                                <h3 className="font-exo text-xl text-white">Assisted Apply Packet</h3>
                                <p className="text-xs text-gray-400">Open the apply page, then copy-paste these answers. When you've submitted the application, mark it as applied below.</p>
                                {reviewingApp.packet?.applyUrl && (
                                    <a href={reviewingApp.packet.applyUrl} target="_blank" rel="noopener noreferrer" className="inline-block px-4 py-2 text-sm font-bold text-slate-900 bg-cyan-500 hover:bg-cyan-400 rounded-lg transition-colors">
                                        Open Apply Page ↗
                                    </a>
                                )}
                                {(reviewingApp.packet?.missing || []).length > 0 && (
                                    <div className="bg-red-900/20 border border-red-500/30 rounded p-3 space-y-1">
                                        <p className="text-xs font-bold text-red-300">Missing from your Profile Vault (never guessed):</p>
                                        {(reviewingApp.packet?.missing || []).map((m, i) => <p key={i} className="text-xs text-red-300">• {m}</p>)}
                                    </div>
                                )}
                                <div className="space-y-1">
                                    {(reviewingApp.packet?.answers || []).map((ans, i) => (
                                        <div key={i} className="flex items-start gap-2 text-sm p-2 bg-gray-900/60 border border-cyan-600/20 rounded">
                                            <span className="text-cyan-300 min-w-[40%] text-xs pt-0.5">{ans.label}</span>
                                            <span className="text-white select-all flex-1">{ans.value}</span>
                                            <button onClick={() => navigator.clipboard?.writeText(ans.value)} className="text-xs text-gray-400 hover:text-cyan-300" title="Copy">⧉</button>
                                        </div>
                                    ))}
                                </div>
                                {reviewingApp.packet?.coverNote && (
                                    <div>
                                        <p className="text-xs font-bold text-cyan-300 mb-1">Cover note (copy-paste ready)</p>
                                        <pre className="whitespace-pre-wrap font-sans text-xs text-gray-200 bg-gray-900/60 border border-cyan-600/20 rounded p-3 select-all">{reviewingApp.packet.coverNote}</pre>
                                    </div>
                                )}
                                <div className="flex flex-wrap gap-3 justify-end">
                                    <button onClick={() => setReviewingApp(null)} className="px-4 py-2 text-sm text-gray-300 border border-gray-500/40 rounded-lg hover:bg-gray-800 transition-colors">Close</button>
                                    <button
                                        onClick={() => handleApprove(reviewingApp)}
                                        disabled={approvingId === reviewingApp.id}
                                        className="px-4 py-2 text-sm font-bold text-slate-900 bg-green-400 hover:bg-green-300 disabled:opacity-50 rounded-lg transition-colors font-exo"
                                    >
                                        {approvingId === reviewingApp.id ? 'Saving…' : "I've Applied — Mark as Submitted"}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {viewingHandoff && (
                <HandoffViewer handoff={viewingHandoff} onClose={() => { setViewingHandoff(null); setHandoffs((prev) => prev.filter((h) => h.id !== viewingHandoff.id)); }} />
            )}

            {viewingShot && (
                <div className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center p-4" onClick={() => setViewingShot(null)}>
                    <div className="max-w-4xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                        <p className="text-sm text-cyan-300 mb-2">{SHOT_LABEL[viewingShot.kind] || viewingShot.kind}</p>
                        <img src={`/api/applications/${viewingShot.appId}/screenshots/${viewingShot.shotId}`} alt={SHOT_LABEL[viewingShot.kind] || 'Application screenshot'} className="w-full border border-cyan-500/40 rounded-lg" />
                    </div>
                </div>
            )}
        </div>
    );
};

export default JobOpportunities;
