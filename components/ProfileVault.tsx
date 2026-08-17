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
    channelModes: Record<string, 'review' | 'auto'> | null;
    seededFromResume?: boolean;
    confirmedAt?: string | null;
}

const EMPTY: Profile = {
    fullName: '', email: '', phone: '', addressLine: '', city: '', country: '',
    linkedinUrl: '', githubUrl: '', portfolioUrl: '', noticePeriod: '', languages: '',
    countryAuth: [], eeoAnswers: {}, screeningAnswers: [], channelModes: {},
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
                if (data) setProfile({ ...EMPTY, ...data, countryAuth: data.countryAuth || [], screeningAnswers: data.screeningAnswers || [], eeoAnswers: data.eeoAnswers || {}, channelModes: data.channelModes || {} });
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
            setProfile({ ...EMPTY, ...data, countryAuth: data.countryAuth || [], screeningAnswers: data.screeningAnswers || [], eeoAnswers: data.eeoAnswers || {}, channelModes: data.channelModes || {} });
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
            setProfile({ ...EMPTY, ...data, countryAuth: data.countryAuth || [], screeningAnswers: data.screeningAnswers || [], eeoAnswers: data.eeoAnswers || {}, channelModes: data.channelModes || {} });
            setSavedAt(new Date().toLocaleTimeString());
        } catch (e: any) { setError(e.message); } finally { setSaving(false); }
    };

    const updateAuth = (i: number, patch: Partial<CountryAuthRecord>) => {
        const list = [...(profile.countryAuth || [])];
        list[i] = { ...list[i], ...patch };
        set('countryAuth', list);
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
