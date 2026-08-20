import React, { useState, useEffect, useCallback } from 'react';
import { BackIcon } from './icons/UIIcons';

interface CountryAuthRecord {
    country: string;
    rightToWork: 'citizen' | 'permanent_resident' | 'work_visa' | 'needs_sponsorship' | 'none';
    visaDetails?: string;
    needsSponsorship: boolean;
    salaryExpectation?: string;
    relocationWilling?: boolean;
    notes?: string;
}

interface ScreeningAnswer { question: string; answer: string }

interface WorkHistoryEntry {
    jobTitle: string;
    employer: string;
    location?: string;
    startDate?: string; // "YYYY-MM"
    endDate?: string; // "YYYY-MM"
    isCurrent?: boolean;
    description?: string;
}

interface EducationEntry {
    school: string;
    degree?: string;
    fieldOfStudy?: string;
    startDate?: string; // "YYYY-MM"
    endDate?: string; // "YYYY-MM"
    isCurrent?: boolean;
    description?: string;
}

interface Profile {
    id?: string;
    fullName: string | null;
    email: string | null;
    phone: string | null;
    addressLine: string | null;
    city: string | null;
    country: string | null;
    linkedinUrl: string | null;
    githubUrl: string | null;
    portfolioUrl: string | null;
    noticePeriod: string | null;
    languages: string | null;
    countryAuth: CountryAuthRecord[] | null;
    eeoAnswers: Record<string, string> | null;
    screeningAnswers: ScreeningAnswer[] | null;
    workHistory: WorkHistoryEntry[] | null;
    education: EducationEntry[] | null;
    dataConsent?: boolean | null;
    channelModes: Record<string, 'review' | 'auto'> | null;
    seededFromResume?: boolean;
    confirmedAt?: string | null;
}

const EMPTY: Profile = {
    fullName: '', email: '', phone: '', addressLine: '', city: '', country: '',
    linkedinUrl: '', githubUrl: '', portfolioUrl: '', noticePeriod: '', languages: '',
    countryAuth: [], eeoAnswers: {}, screeningAnswers: [], workHistory: [], education: [],
    dataConsent: false, channelModes: {},
};

const RIGHT_TO_WORK_OPTIONS: Array<{ value: CountryAuthRecord['rightToWork']; label: string }> = [
    { value: 'citizen', label: 'Citizen' },
    { value: 'permanent_resident', label: 'Permanent resident' },
    { value: 'work_visa', label: 'Hold a work visa' },
    { value: 'needs_sponsorship', label: 'Need sponsorship' },
    { value: 'none', label: 'No right to work' },
];

const inputCls = 'w-full px-3 py-2 bg-gray-900/70 border border-cyan-500/30 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-400';
const labelCls = 'block text-xs text-cyan-300 mb-1';

interface AtsCredMeta {
    id: string; company: string; atsType: string; portalDomain: string; portalUrl: string;
    email: string; status: string; notes: string | null; createdAt: string | null; lastUsedAt: string | null;
}
interface DomainControl {
    domain: string; blockCount: number; cooldownUntil: string | null; downgraded: boolean;
}

const AtsAccountsSection: React.FC = () => {
    const [creds, setCreds] = useState<AtsCredMeta[]>([]);
    const [controls, setControls] = useState<DomainControl[]>([]);
    const [revealed, setRevealed] = useState<Record<string, string>>({});
    const [err, setErr] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const [cr, dc] = await Promise.all([
                fetch('/api/vault/credentials').then((r) => r.ok ? r.json() : []),
                fetch('/api/vault/domain-controls').then((r) => r.ok ? r.json() : []),
            ]);
            setCreds(cr); setControls(dc);
        } catch { /* noop */ }
    }, []);
    useEffect(() => { load(); }, [load]);

    const reveal = async (id: string) => {
        if (revealed[id]) { setRevealed((r) => { const n = { ...r }; delete n[id]; return n; }); return; }
        setErr(null);
        try {
            const res = await fetch(`/api/vault/credentials/${id}/reveal`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Reveal failed');
            setRevealed((r) => ({ ...r, [id]: data.password }));
        } catch (e: any) { setErr(e.message); }
    };
    const remove = async (id: string) => {
        if (!window.confirm('Delete this saved portal account? You will lose the stored password.')) return;
        await fetch(`/api/vault/credentials/${id}`, { method: 'DELETE' });
        load();
    };
    const resetDomain = async (domain: string) => {
        await fetch(`/api/vault/domain-controls/${encodeURIComponent(domain)}/reset`, { method: 'POST' });
        load();
    };

    const flagged = controls.filter((c) => c.downgraded || (c.cooldownUntil && new Date(c.cooldownUntil) > new Date()) || c.blockCount > 0);

    return (
        <section className="p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg space-y-3">
            <h3 className="font-exo text-lg text-cyan-300">ATS Portal Accounts</h3>
            <p className="text-xs text-gray-500">Accounts the apply engine creates on employer portals (Workday, iCIMS, Taleo…). The password is saved here <span className="text-cyan-300">before</span> any signup form is submitted, so you can always log in yourself.</p>
            {err && <p className="text-xs text-red-400">{err}</p>}
            {creds.length === 0 && <p className="text-xs text-gray-500 italic">No portal accounts yet — one is created automatically the first time a Workday-style application runs.</p>}
            {creds.map((c) => (
                <div key={c.id} className="p-3 bg-gray-900/70 border border-purple-500/20 rounded-lg text-xs text-gray-300 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-white">{c.company}</span>
                        <span className="px-2 py-0.5 bg-cyan-900/40 text-cyan-300 border border-cyan-500/30 rounded-full uppercase text-[10px]">{c.atsType}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] border ${c.status === 'login_failed' ? 'bg-red-900/40 text-red-300 border-red-500/30' : 'bg-green-900/30 text-green-300 border-green-500/30'}`}>{c.status.replace('_', ' ')}</span>
                        <button onClick={() => remove(c.id)} className="ml-auto text-red-400 hover:text-red-300">Delete</button>
                    </div>
                    <div><a href={c.portalUrl} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline break-all">{c.portalDomain}</a></div>
                    <div>Login email: <span className="text-white">{c.email}</span></div>
                    <div className="flex items-center gap-2">
                        Password: <span className="font-mono text-white">{revealed[c.id] ?? '••••••••••••'}</span>
                        <button onClick={() => reveal(c.id)} className="text-cyan-300 hover:text-white border border-cyan-400/40 rounded-full px-2 py-0.5">{revealed[c.id] ? 'Hide' : 'Show'}</button>
                    </div>
                </div>
            ))}
            {flagged.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-sm text-cyan-300 font-exo">Automation guard-rails</h4>
                    {flagged.map((c) => (
                        <div key={c.domain} className="flex flex-wrap items-center gap-2 text-xs text-gray-300 p-2 bg-gray-900/70 border border-amber-500/20 rounded">
                            <span className="text-white">{c.domain}</span>
                            <span>{c.blockCount} block(s)</span>
                            {c.downgraded && <span className="px-2 py-0.5 bg-amber-900/40 text-amber-300 border border-amber-500/30 rounded-full text-[10px]">Assisted mode only</span>}
                            {!c.downgraded && c.cooldownUntil && new Date(c.cooldownUntil) > new Date() && <span className="text-amber-300">cooling down until {new Date(c.cooldownUntil).toLocaleTimeString()}</span>}
                            <button onClick={() => resetDomain(c.domain)} className="ml-auto text-cyan-300 hover:text-white border border-cyan-400/40 rounded-full px-2 py-0.5">Reset</button>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
};

const ProfileVault: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const [profile, setProfile] = useState<Profile>(EMPTY);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [seeding, setSeeding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [savedAt, setSavedAt] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/profile');
            if (res.ok) {
                const data = await res.json();
                if (data) setProfile({ ...EMPTY, ...data, countryAuth: data.countryAuth || [], screeningAnswers: data.screeningAnswers || [], eeoAnswers: data.eeoAnswers || {}, workHistory: data.workHistory || [], education: data.education || [], channelModes: data.channelModes || {} });
            }
        } catch { /* noop */ } finally { setLoading(false); }
    }, []);

    useEffect(() => { load(); }, [load]);

    const set = (field: keyof Profile, value: any) => { setProfile((p) => ({ ...p, [field]: value })); setSavedAt(null); };

    const handleSeed = async () => {
        setSeeding(true); setError(null);
        try {
            const res = await fetch('/api/profile/seed', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || 'Seeding failed');
            setProfile({ ...EMPTY, ...data, countryAuth: data.countryAuth || [], screeningAnswers: data.screeningAnswers || [], eeoAnswers: data.eeoAnswers || {}, workHistory: data.workHistory || [], education: data.education || [], channelModes: data.channelModes || {} });
        } catch (e: any) { setError(e.message); } finally { setSeeding(false); }
    };

    const handleSave = async () => {
        setSaving(true); setError(null);
        try {
            const res = await fetch('/api/profile', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(profile),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || 'Save failed');
            setProfile({ ...EMPTY, ...data, countryAuth: data.countryAuth || [], screeningAnswers: data.screeningAnswers || [], eeoAnswers: data.eeoAnswers || {}, workHistory: data.workHistory || [], education: data.education || [], channelModes: data.channelModes || {} });
            setSavedAt(new Date().toLocaleTimeString());
        } catch (e: any) { setError(e.message); } finally { setSaving(false); }
    };

    const updateAuth = (i: number, patch: Partial<CountryAuthRecord>) => {
        const list = [...(profile.countryAuth || [])];
        list[i] = { ...list[i], ...patch };
        set('countryAuth', list);
    };

    const updateWork = (i: number, patch: Partial<WorkHistoryEntry>) => {
        const list = [...(profile.workHistory || [])];
        list[i] = { ...list[i], ...patch };
        set('workHistory', list);
    };

    const updateEdu = (i: number, patch: Partial<EducationEntry>) => {
        const list = [...(profile.education || [])];
        list[i] = { ...list[i], ...patch };
        set('education', list);
    };

    if (loading) return <div className="h-full flex items-center justify-center text-gray-400">Loading profile vault…</div>;

    return (
        <div className="h-full flex flex-col p-4 bg-black/30 border border-cyan-500/20 rounded-lg backdrop-blur-md overflow-y-auto animate-fade-in">
            <div className="flex-shrink-0 flex items-center justify-between mb-6">
                <button onClick={onBack} className="flex items-center space-x-2 text-cyan-300 hover:text-white transition-colors">
                    <BackIcon />
                    <span className="font-bold font-exo">Back to Dashboard</span>
                </button>
                <h2 className="font-exo text-2xl text-white">Profile Vault</h2>
            </div>

            <div className="max-w-3xl mx-auto w-full space-y-6 pb-8">
                <p className="text-xs text-gray-400">
                    Answers stored here are used to prepare job applications. Visa, sponsorship and demographic answers are <span className="text-cyan-300 font-semibold">only ever taken from what you enter here</span> — the apply engine never guesses them. If an answer is missing, the application pauses and asks you.
                </p>

                {error && <p className="text-sm text-red-400 bg-red-900/20 border border-red-500/30 rounded-lg p-3">{error}</p>}

                {/* Basics */}
                <section className="p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="font-exo text-lg text-cyan-300">Basics</h3>
                        <button onClick={handleSeed} disabled={seeding} className="px-3 py-1.5 text-xs text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 disabled:opacity-50 transition-colors">
                            {seeding ? 'Reading CV…' : 'Fill from my CV'}
                        </button>
                    </div>
                    {profile.seededFromResume && !profile.confirmedAt && (
                        <p className="text-xs text-amber-300 bg-amber-900/20 border border-amber-500/30 rounded p-2">These basics were pre-filled from your CV — please check them and press Save to confirm.</p>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div><label className={labelCls}>Full name</label><input className={inputCls} value={profile.fullName || ''} onChange={(e) => set('fullName', e.target.value)} /></div>
                        <div><label className={labelCls}>Email</label><input className={inputCls} value={profile.email || ''} onChange={(e) => set('email', e.target.value)} /></div>
                        <div><label className={labelCls}>Phone</label><input className={inputCls} value={profile.phone || ''} onChange={(e) => set('phone', e.target.value)} /></div>
                        <div><label className={labelCls}>Notice period</label><input className={inputCls} placeholder="e.g. 1 month" value={profile.noticePeriod || ''} onChange={(e) => set('noticePeriod', e.target.value)} /></div>
                        <div><label className={labelCls}>City</label><input className={inputCls} value={profile.city || ''} onChange={(e) => set('city', e.target.value)} /></div>
                        <div><label className={labelCls}>Country</label><input className={inputCls} value={profile.country || ''} onChange={(e) => set('country', e.target.value)} /></div>
                        <div><label className={labelCls}>LinkedIn URL</label><input className={inputCls} value={profile.linkedinUrl || ''} onChange={(e) => set('linkedinUrl', e.target.value)} /></div>
                        <div><label className={labelCls}>GitHub URL</label><input className={inputCls} value={profile.githubUrl || ''} onChange={(e) => set('githubUrl', e.target.value)} /></div>
                        <div><label className={labelCls}>Portfolio URL</label><input className={inputCls} value={profile.portfolioUrl || ''} onChange={(e) => set('portfolioUrl', e.target.value)} /></div>
                        <div><label className={labelCls}>Languages</label><input className={inputCls} placeholder="English (fluent), Hindi (native)" value={profile.languages || ''} onChange={(e) => set('languages', e.target.value)} /></div>
                    </div>
                </section>

                {/* Work authorization per country */}
                <section className="p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg space-y-3">
                    <h3 className="font-exo text-lg text-cyan-300">Work Authorization (per country)</h3>
                    <p className="text-xs text-gray-500">Add one record per country you're applying in. Applications for countries without a record will pause and ask you first.</p>
                    {(profile.countryAuth || []).map((rec, i) => (
                        <div key={i} className="p-3 bg-gray-900/70 border border-purple-500/20 rounded-lg space-y-2">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div><label className={labelCls}>Country</label><input className={inputCls} value={rec.country} onChange={(e) => updateAuth(i, { country: e.target.value })} /></div>
                                <div>
                                    <label className={labelCls}>Right to work</label>
                                    <select className={inputCls} value={rec.rightToWork} onChange={(e) => updateAuth(i, { rightToWork: e.target.value as any, needsSponsorship: e.target.value === 'needs_sponsorship' ? true : rec.needsSponsorship })}>
                                        {RIGHT_TO_WORK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                </div>
                                <div><label className={labelCls}>Visa details (optional)</label><input className={inputCls} placeholder="e.g. Employment Pass, valid to 2027" value={rec.visaDetails || ''} onChange={(e) => updateAuth(i, { visaDetails: e.target.value })} /></div>
                                <div><label className={labelCls}>Salary expectation (optional)</label><input className={inputCls} placeholder="e.g. RM 12,000/month" value={rec.salaryExpectation || ''} onChange={(e) => updateAuth(i, { salaryExpectation: e.target.value })} /></div>
                            </div>
                            <div className="flex flex-wrap items-center gap-4 text-xs text-gray-300">
                                <label className="flex items-center gap-2"><input type="checkbox" checked={rec.needsSponsorship} onChange={(e) => updateAuth(i, { needsSponsorship: e.target.checked })} /> Requires visa sponsorship</label>
                                <label className="flex items-center gap-2"><input type="checkbox" checked={!!rec.relocationWilling} onChange={(e) => updateAuth(i, { relocationWilling: e.target.checked })} /> Willing to relocate</label>
                                <button onClick={() => set('countryAuth', (profile.countryAuth || []).filter((_, x) => x !== i))} className="ml-auto text-red-400 hover:text-red-300">Remove</button>
                            </div>
                        </div>
                    ))}
                    <button onClick={() => set('countryAuth', [...(profile.countryAuth || []), { country: '', rightToWork: 'needs_sponsorship', needsSponsorship: true }])} className="px-3 py-1.5 text-xs text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors">
                        + Add country
                    </button>
                </section>

                {/* Work history */}
                <section className="p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg space-y-3">
                    <h3 className="font-exo text-lg text-cyan-300">Work History</h3>
                    <p className="text-xs text-gray-500">
                        The source of truth for an employer portal's own "Work Experience" section (e.g. Workday). Portals that auto-parse
                        your uploaded resume into these fields frequently get it wrong — mismatched titles, garbled dates, merged entries. The
                        apply engine <span className="text-cyan-300">always overwrites</span> whatever the portal auto-fills with what's entered here.
                    </p>
                    {(profile.workHistory || []).map((w, i) => (
                        <div key={i} className="p-3 bg-gray-900/70 border border-purple-500/20 rounded-lg space-y-2">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div><label className={labelCls}>Job title</label><input className={inputCls} value={w.jobTitle} onChange={(e) => updateWork(i, { jobTitle: e.target.value })} /></div>
                                <div><label className={labelCls}>Employer</label><input className={inputCls} value={w.employer} onChange={(e) => updateWork(i, { employer: e.target.value })} /></div>
                                <div><label className={labelCls}>Location (optional)</label><input className={inputCls} value={w.location || ''} onChange={(e) => updateWork(i, { location: e.target.value })} /></div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div><label className={labelCls}>Start (YYYY-MM)</label><input className={inputCls} placeholder="2019-05" value={w.startDate || ''} onChange={(e) => updateWork(i, { startDate: e.target.value })} /></div>
                                    <div><label className={labelCls}>End (YYYY-MM)</label><input className={inputCls} placeholder="2022-08" disabled={!!w.isCurrent} value={w.endDate || ''} onChange={(e) => updateWork(i, { endDate: e.target.value })} /></div>
                                </div>
                            </div>
                            <div><label className={labelCls}>Description (optional)</label><textarea className={inputCls} rows={2} value={w.description || ''} onChange={(e) => updateWork(i, { description: e.target.value })} /></div>
                            <div className="flex flex-wrap items-center gap-4 text-xs text-gray-300">
                                <label className="flex items-center gap-2"><input type="checkbox" checked={!!w.isCurrent} onChange={(e) => updateWork(i, { isCurrent: e.target.checked, endDate: e.target.checked ? undefined : w.endDate })} /> I currently work here</label>
                                <button onClick={() => set('workHistory', (profile.workHistory || []).filter((_, x) => x !== i))} className="ml-auto text-red-400 hover:text-red-300">Remove</button>
                            </div>
                        </div>
                    ))}
                    <button onClick={() => set('workHistory', [...(profile.workHistory || []), { jobTitle: '', employer: '' }])} className="px-3 py-1.5 text-xs text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors">
                        + Add position
                    </button>
                </section>

                {/* Education */}
                <section className="p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg space-y-3">
                    <h3 className="font-exo text-lg text-cyan-300">Education</h3>
                    <p className="text-xs text-gray-500">Same rationale as Work History, for a portal's native "Education" section.</p>
                    {(profile.education || []).map((ed, i) => (
                        <div key={i} className="p-3 bg-gray-900/70 border border-purple-500/20 rounded-lg space-y-2">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div><label className={labelCls}>School</label><input className={inputCls} value={ed.school} onChange={(e) => updateEdu(i, { school: e.target.value })} /></div>
                                <div><label className={labelCls}>Degree (optional)</label><input className={inputCls} value={ed.degree || ''} onChange={(e) => updateEdu(i, { degree: e.target.value })} /></div>
                                <div><label className={labelCls}>Field of study (optional)</label><input className={inputCls} value={ed.fieldOfStudy || ''} onChange={(e) => updateEdu(i, { fieldOfStudy: e.target.value })} /></div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div><label className={labelCls}>Start (YYYY-MM)</label><input className={inputCls} placeholder="2013-09" value={ed.startDate || ''} onChange={(e) => updateEdu(i, { startDate: e.target.value })} /></div>
                                    <div><label className={labelCls}>End (YYYY-MM)</label><input className={inputCls} placeholder="2017-06" disabled={!!ed.isCurrent} value={ed.endDate || ''} onChange={(e) => updateEdu(i, { endDate: e.target.value })} /></div>
                                </div>
                            </div>
                            <div><label className={labelCls}>Description (optional)</label><textarea className={inputCls} rows={2} value={ed.description || ''} onChange={(e) => updateEdu(i, { description: e.target.value })} /></div>
                            <div className="flex flex-wrap items-center gap-4 text-xs text-gray-300">
                                <label className="flex items-center gap-2"><input type="checkbox" checked={!!ed.isCurrent} onChange={(e) => updateEdu(i, { isCurrent: e.target.checked, endDate: e.target.checked ? undefined : ed.endDate })} /> Currently studying here</label>
                                <button onClick={() => set('education', (profile.education || []).filter((_, x) => x !== i))} className="ml-auto text-red-400 hover:text-red-300">Remove</button>
                            </div>
                        </div>
                    ))}
                    <button onClick={() => set('education', [...(profile.education || []), { school: '' }])} className="px-3 py-1.5 text-xs text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors">
                        + Add education
                    </button>
                </section>

                {/* Standard screening answers */}
                <section className="p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg space-y-3">
                    <h3 className="font-exo text-lg text-cyan-300">Standard Screening Answers</h3>
                    <p className="text-xs text-gray-500">Common questions forms ask (years of experience, earliest start date, why this company…). These are copied into every application packet.</p>
                    {(profile.screeningAnswers || []).map((sa, i) => (
                        <div key={i} className="flex flex-col sm:flex-row gap-2">
                            <input className={inputCls + ' sm:w-2/5'} placeholder="Question" value={sa.question} onChange={(e) => { const l = [...(profile.screeningAnswers || [])]; l[i] = { ...l[i], question: e.target.value }; set('screeningAnswers', l); }} />
                            <input className={inputCls + ' flex-1'} placeholder="Answer" value={sa.answer} onChange={(e) => { const l = [...(profile.screeningAnswers || [])]; l[i] = { ...l[i], answer: e.target.value }; set('screeningAnswers', l); }} />
                            <button onClick={() => set('screeningAnswers', (profile.screeningAnswers || []).filter((_, x) => x !== i))} className="text-xs text-red-400 hover:text-red-300 self-center">Remove</button>
                        </div>
                    ))}
                    <button onClick={() => set('screeningAnswers', [...(profile.screeningAnswers || []), { question: '', answer: '' }])} className="px-3 py-1.5 text-xs text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors">
                        + Add answer
                    </button>
                </section>

                {/* EEO / demographic answers */}
                <section className="p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg space-y-3">
                    <h3 className="font-exo text-lg text-cyan-300">EEO / Demographic Answers (optional)</h3>
                    <p className="text-xs text-gray-500">Some forms ask optional demographic questions (gender, ethnicity, veteran status, disability). Answers here are used exactly as written — leave this empty and those questions are simply not answered. They are never guessed on your behalf.</p>
                    {Object.entries(profile.eeoAnswers || {}).map(([q, a], i) => (
                        <div key={i} className="flex flex-col sm:flex-row gap-2">
                            <input className={inputCls + ' sm:w-2/5'} placeholder="Question (e.g. Gender)" value={q} onChange={(e) => {
                                const entries = Object.entries(profile.eeoAnswers || {});
                                entries[i] = [e.target.value, a];
                                set('eeoAnswers', Object.fromEntries(entries));
                            }} />
                            <input className={inputCls + ' flex-1'} placeholder='Answer (e.g. Male, or "Prefer not to say")' value={a} onChange={(e) => {
                                const entries = Object.entries(profile.eeoAnswers || {});
                                entries[i] = [q, e.target.value];
                                set('eeoAnswers', Object.fromEntries(entries));
                            }} />
                            <button onClick={() => {
                                const next = { ...(profile.eeoAnswers || {}) };
                                delete next[q];
                                set('eeoAnswers', next);
                            }} className="text-xs text-red-400 hover:text-red-300 self-center">Remove</button>
                        </div>
                    ))}
                    <button onClick={() => set('eeoAnswers', { ...(profile.eeoAnswers || {}), '': '' })} className="px-3 py-1.5 text-xs text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors">
                        + Add EEO answer
                    </button>
                </section>

                {/* GDPR / data-processing consent */}
                <section className="p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg space-y-2">
                    <h3 className="font-exo text-lg text-cyan-300">Data &amp; Privacy Consent</h3>
                    <p className="text-xs text-gray-500">
                        Common on EU/Swiss/UK portals: a checkbox consenting to your personal data being processed for this application (GDPR).
                        This is a legal yes/no the engine never guesses — leave it off and every such checkbox pauses the application for you to confirm manually.
                    </p>
                    <label className="flex items-center gap-2 text-sm text-gray-300">
                        <input type="checkbox" checked={!!profile.dataConsent} onChange={(e) => set('dataConsent', e.target.checked)} />
                        I consent to my personal data being processed by employer application portals
                    </label>
                </section>

                {/* ATS portal accounts (credential vault) */}
                <AtsAccountsSection />

                {/* Submission mode */}
                <section className="p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg space-y-2">
                    <h3 className="font-exo text-lg text-cyan-300">Submission Mode</h3>
                    <label className="flex items-center gap-2 text-sm text-gray-300">
                        <input
                            type="checkbox"
                            checked={(profile.channelModes || {}).email !== 'auto'}
                            onChange={(e) => set('channelModes', { ...(profile.channelModes || {}), email: e.target.checked ? 'review' : 'auto' })}
                        />
                        Review every application email before it is sent (recommended)
                    </label>
                    <p className="text-xs text-gray-500">Phase 1 always prepares applications for your review; automatic sending without review is reserved for a later phase.</p>
                </section>

                <div className="flex items-center gap-3">
                    <button onClick={handleSave} disabled={saving} className="px-6 py-2 text-sm font-bold text-slate-900 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 rounded-lg transition-colors btn-glow font-exo">
                        {saving ? 'Saving…' : 'Save Profile Vault'}
                    </button>
                    {savedAt && <span className="text-xs text-green-400">Saved at {savedAt} ✓</span>}
                </div>
            </div>
        </div>
    );
};

export default ProfileVault;
