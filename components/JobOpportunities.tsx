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
            const res = await fetch(`/api/jobs?date=${encodeURIComponent(date)}`);
            if (!res.ok) throw new Error('Failed to load shortlist');
            setJobs(await res.json());
        } catch (e: any) {
            setError(e.message || 'Failed to load jobs');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadDates(); }, [loadDates]);
    useEffect(() => { if (selectedDate) loadJobs(selectedDate); }, [selectedDate, loadJobs]);

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

    const handleTailorCv = async (job: JobMatch) => {
        if (job.tailoredCv) {
            setViewingCv(job);
            return;
        }
        setTailoringId(job.id);
        setError(null);
        try {
            const res = await fetch(`/api/jobs/${job.id}/tailor-cv`, { method: 'POST' });
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
                                    </div>
                                </div>
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
