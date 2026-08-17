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
    useEffect(() => { if (jobs.length) { loadQuestions(jobs.map((j) => j.id)); loadContacts(jobs.map((j) => j.id)); } }, [jobs, loadQuestions, loadContacts]);

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
                                <div className="flex flex-wrap gap-2 mt-3">
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
        </div>
    );
};

export default JobOpportunities;
