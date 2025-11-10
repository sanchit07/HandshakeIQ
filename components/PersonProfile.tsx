

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Person, GroundingChunk, Insight, IntelligenceReport } from '../types';
import { generateIntelligenceReport } from '../services/geminiService';
import { BackIcon, CommentIcon, CrmIcon, SaveIcon, LinkIcon, ReminderIcon, LinkedInSourceIcon, NewsArticleIcon, BlogPostIcon, BookmarkIcon, ChevronDownIcon, RefreshIcon } from './icons/UIIcons';
import { ScanningLoader, ProfileBuildingLoader } from './loaders/NeonLoader';

const LoadingIndicator: React.FC = () => (
    <div className="flex flex-col items-center justify-center h-full text-center p-4 sm:p-8">
        <div className="animate-slide-up-fade">
            <ScanningLoader target="operative" />
        </div>
        <div className="mt-8 w-full max-w-md animate-fade-in" style={{animationDelay: '0.5s'}}>
            <ProfileBuildingLoader />
        </div>
    </div>
);


const ConfidenceMeter: React.FC<{ score: number }> = ({ score }) => {
    const getBarColor = (s: number) => {
      if (s < 50) return 'bg-yellow-500/80';
      if (s < 80) return 'bg-cyan-500';
      return 'bg-cyan-300';
    };
  
    return (
      <div className="flex items-center space-x-2" title={`Confidence: ${score}%`}>
        <div className="w-full bg-gray-800/50 rounded-full h-1.5 border border-cyan-500/20">
          <div 
            className={`${getBarColor(score)} h-full rounded-full transition-all duration-500`}
            style={{ width: `${score}%` }}
          ></div>
        </div>
        <span className="text-xs font-mono w-8 text-right text-cyan-300">{score}%</span>
      </div>
    );
};

const getSourceIcon = (uri: string): { key: string; icon: React.ReactNode } => {
    const lowerCaseUri = uri.toLowerCase();
    if (lowerCaseUri.includes('linkedin.com')) {
        return { key: 'linkedin', icon: <LinkedInSourceIcon /> };
    }
    if (lowerCaseUri.includes('news') || lowerCaseUri.includes('article') || lowerCaseUri.includes('forbes') || lowerCaseUri.includes('techcrunch') || lowerCaseUri.includes('reuters')) {
        return { key: 'news', icon: <NewsArticleIcon /> };
    }
    if (lowerCaseUri.includes('blog') || lowerCaseUri.includes('medium.com')) {
        return { key: 'blog', icon: <BlogPostIcon /> };
    }
    return { key: 'link', icon: <LinkIcon /> };
};

const InsightPoint: React.FC<{
    point: Insight['points'][0];
    sources: GroundingChunk[];
    isHighlighted: boolean;
    setHighlightedIndices: (indices: Set<number> | null) => void;
}> = ({ point, sources, isHighlighted, setHighlightedIndices }) => {
    
    const sourceIcons = useMemo(() => {
        if (!point.source_indices || !sources) return [];
        const iconsMap = new Map<string, { node: React.ReactNode, title: string }>();
        point.source_indices.forEach(index => {
            const source = sources[index];
            if (source?.web?.uri) {
                const { key, icon } = getSourceIcon(source.web.uri);
                if (!iconsMap.has(key)) {
                    iconsMap.set(key, { node: icon, title: source.web.title || key });
                }
            }
        });
        return Array.from(iconsMap.values());
    }, [point.source_indices, sources]);

    return (
        <li
            className={`grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 p-2 rounded-md transition-all duration-300 ${isHighlighted ? 'bg-cyan-900/50 ring-1 ring-cyan-500' : ''}`}
            onMouseEnter={() => point.source_indices && setHighlightedIndices(new Set(point.source_indices))}
            onMouseLeave={() => setHighlightedIndices(null)}
        >
            <p className="text-gray-300 text-sm md:text-base">{point.text}</p>
            <div className="flex items-center space-x-3">
                <div className="flex items-center justify-end space-x-1.5 h-4 w-20">
                    {sourceIcons.slice(0, 4).map((iconInfo, index) => (
                        <span key={index} title={iconInfo.title}>{iconInfo.node}</span>
                    ))}
                </div>
                <div className="w-28">
                    <ConfidenceMeter score={point.confidence} />
                </div>
            </div>
        </li>
    );
};

const InsightSection: React.FC<{
    insight: Insight;
    sources: GroundingChunk[];
    highlightedIndices: Set<number> | null;
    setHighlightedIndices: (indices: Set<number> | null) => void;
    onSaveInsight: (insight: Insight) => void;
    isSaved: boolean;
}> = ({ insight, sources, highlightedIndices, setHighlightedIndices, onSaveInsight, isSaved }) => {
    const [isExpanded, setIsExpanded] = useState(true);

    const isPointHighlighted = (point: Insight['points'][0]): boolean => {
        if (!highlightedIndices || !point.source_indices) return false;
        return point.source_indices.some(i => highlightedIndices.has(i));
    };

    const categoryId = `insight-content-${insight.category.replace(/\s+/g, '-')}`;

    return (
        <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="flex items-center space-x-3 text-left group"
                    aria-expanded={isExpanded}
                    aria-controls={categoryId}
                >
                    {isSaved && <BookmarkIcon className="text-cyan-400" />}
                    <h4 className="font-exo text-lg text-cyan-300 border-b-2 border-cyan-500/30 pb-1 transition-colors group-hover:text-white">{insight.category}</h4>
                    <ChevronDownIcon className={`transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''} text-cyan-400`} />
                </button>
                <button
                    onClick={() => onSaveInsight(insight)}
                    disabled={isSaved}
                    className="px-3 py-1 text-xs font-semibold text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                    {isSaved ? 'Saved' : 'Save Insight'}
                </button>
            </div>
            <div
                id={categoryId}
                className={`transition-all duration-500 ease-in-out overflow-hidden ${isExpanded ? 'max-h-[1000px]' : 'max-h-0'}`}
            >
                <ul className="space-y-3 pt-1 pl-2 border-l border-cyan-500/20">
                    {insight.points.map((point, index) => (
                       <InsightPoint
                           key={index}
                           point={point}
                           sources={sources}
                           isHighlighted={isPointHighlighted(point)}
                           setHighlightedIndices={setHighlightedIndices}
                       />
                    ))}
                </ul>
            </div>
        </div>
    );
};



const PersonProfile: React.FC<{ person: Person; onBack: () => void; onSave: (person: Person) => void; }> = ({ person, onBack, onSave }) => {
    const [report, setReport] = useState<IntelligenceReport | null>(null);
    const [sources, setSources] = useState<GroundingChunk[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [highlightedIndices, setHighlightedIndices] = useState<Set<number> | null>(null);
    const [savedInsights, setSavedInsights] = useState<Insight[]>([]);
    const [linkedInUrls, setLinkedInUrls] = useState<string[]>([]);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        setReport(null);
        setSources([]);
        setLinkedInUrls([]);
        
        // Track start time for minimum loader duration
        const loadStartTime = Date.now();
        const MIN_LOADER_DURATION = 2000; // 2 seconds to ensure smooth animation display
        
        try {
            const { report: fetchedReport, sources: fetchedSources } = await generateIntelligenceReport(person.name, person.company, person.allLinks);
            setReport(fetchedReport);
            setSources(fetchedSources);

            if (fetchedReport.rawText) {
                const regex = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/g;
                const matches = fetchedReport.rawText.match(regex);
                if (matches) {
                    setLinkedInUrls([...new Set(matches)]);
                }
            }
        } catch (err) {
            setError('Failed to retrieve intelligence. Network instability detected.');
            console.error(err);
        } finally {
            // Ensure minimum loader display time for smooth animations
            const elapsed = Date.now() - loadStartTime;
            const remainingTime = MIN_LOADER_DURATION - elapsed;
            
            if (remainingTime > 0) {
                // Wait for remaining time to ensure loaders complete their animations
                await new Promise(resolve => setTimeout(resolve, remainingTime));
            }
            
            setIsLoading(false);
        }
    }, [person]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const handleSave = () => {
        onSave(person);
        // A more subtle notification could be used here in a real app
        alert(`${person.name}'s dossier has been saved.`);
    };

    const handleSaveInsight = useCallback((insightToSave: Insight) => {
        setSavedInsights(prev => {
            if (prev.some(i => i.category === insightToSave.category)) {
                return prev;
            }
            return [...prev, insightToSave];
        });
    }, []);

    const isInsightSaved = (category: string) => savedInsights.some(si => si.category === category);

    return (
        <div className="h-full flex flex-col p-2 sm:p-4 bg-black/30 border border-cyan-500/20 rounded-lg backdrop-blur-md overflow-hidden animate-fade-in">
            <div className="flex-shrink-0 flex items-center justify-between mb-3 sm:mb-4 p-2">
                <button onClick={onBack} className="flex items-center space-x-1 sm:space-x-2 text-cyan-300 hover:text-white transition-colors">
                    <BackIcon />
                    <span className="font-bold font-exo text-sm sm:text-base">Back to Dashboard</span>
                </button>
            </div>

            {isLoading ? <LoadingIndicator /> : error ? (
                <div className="flex items-center justify-center h-full text-center text-red-400 p-4 sm:p-8 text-sm sm:text-base">{error}</div>
            ) : report && (
                <div className="flex-grow grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 overflow-hidden">
                    {/* Left Column - Profile & Actions */}
                    <div className="lg:col-span-1 space-y-3 sm:space-y-4 overflow-y-auto pr-1 sm:pr-2">
                        <div className="p-3 sm:p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg text-center animate-slide-down-fade">
                            <img src={person.photoUrl} alt={person.name} className="w-24 h-24 sm:w-32 sm:h-32 rounded-full mx-auto border-4 border-cyan-500/50 shadow-lg shadow-cyan-500/20 animate-pulse-glow" />
                            <div className="mt-3 sm:mt-4 flex items-center justify-center space-x-2">
                                <h2 className="font-exo text-xl sm:text-2xl text-white">{person.name}</h2>
                                <button
                                    onClick={fetchReport}
                                    disabled={isLoading}
                                    className="p-2 text-cyan-400 rounded-full hover:bg-cyan-500/20 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-wait"
                                    aria-label="Refresh Intel"
                                    title="Refresh Intel"
                                >
                                    <RefreshIcon className={`w-4 h-4 sm:w-5 sm:h-5 ${isLoading ? 'animate-spin' : ''}`} />
                                </button>
                            </div>
                            <p className="text-cyan-300 text-sm sm:text-base">{person.title} at {person.company}</p>
                        </div>

                        {linkedInUrls.length > 0 && (
                            <div className="p-3 sm:p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg animate-slide-up-fade" style={{animationDelay: '0.1s'}}>
                                <h3 className="font-exo text-base sm:text-lg text-cyan-300 mb-2 sm:mb-3">LinkedIn Profiles</h3>
                                {linkedInUrls.length > 1 ? (
                                    <details className="group">
                                        <summary className="cursor-pointer flex justify-between items-center text-cyan-200 group-hover:text-white text-sm sm:text-base">
                                            <span>{linkedInUrls.length} profiles found</span>
                                            <ChevronDownIcon className="transition-transform duration-300 group-open:rotate-180" />
                                        </summary>
                                        <div className="mt-2 space-y-2 pt-2 border-t border-cyan-500/20">
                                            {linkedInUrls.map((url, index) => (
                                                <a href={url} target="_blank" rel="noopener noreferrer" key={index} className="w-full flex items-center space-x-2 sm:space-x-3 px-3 sm:px-4 py-2 bg-cyan-900/40 hover:bg-cyan-800/60 rounded transition-colors btn-glow text-xs sm:text-sm">
                                                    <LinkedInSourceIcon />
                                                    <span className="truncate">{url.replace('https://www.linkedin.com/in/', '')}</span>
                                                </a>
                                            ))}
                                        </div>
                                    </details>
                                ) : (
                                    <a href={linkedInUrls[0]} target="_blank" rel="noopener noreferrer" className="w-full flex items-center space-x-2 sm:space-x-3 px-3 sm:px-4 py-2 bg-cyan-900/40 hover:bg-cyan-800/60 rounded transition-colors btn-glow text-sm sm:text-base">
                                        <LinkedInSourceIcon />
                                        <span>View Profile</span>
                                    </a>
                                )}
                            </div>
                        )}

                        <div className="p-3 sm:p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg animate-slide-up-fade" style={{animationDelay: '0.2s'}}>
                             <h3 className="font-exo text-base sm:text-lg text-cyan-300 mb-2 sm:mb-3">Actions</h3>
                            <div className="space-y-2">
                                <button onClick={handleSave} className="w-full flex items-center space-x-2 sm:space-x-3 px-3 sm:px-4 py-2 bg-cyan-900/40 hover:bg-cyan-800/60 rounded transition-colors btn-glow text-sm sm:text-base"><SaveIcon /><span>Save Dossier</span></button>
                                <button className="w-full flex items-center space-x-2 sm:space-x-3 px-3 sm:px-4 py-2 bg-cyan-900/40 hover:bg-cyan-800/60 rounded transition-colors btn-glow text-sm sm:text-base"><CommentIcon /><span>Add Field Notes</span></button>
                                <button className="w-full flex items-center space-x-2 sm:space-x-3 px-3 sm:px-4 py-2 bg-cyan-900/40 hover:bg-cyan-800/60 rounded transition-colors btn-glow text-sm sm:text-base"><ReminderIcon /><span>Set Reminder</span></button>
                                <button className="w-full flex items-center space-x-2 sm:space-x-3 px-3 sm:px-4 py-2 bg-cyan-900/40 hover:bg-cyan-800/60 rounded transition-colors btn-glow text-sm sm:text-base"><CrmIcon /><span>Send to CRM</span></button>
                            </div>
                        </div>

                        {savedInsights.length > 0 && (
                            <div className="p-4 bg-cyan-900/25 border-2 border-cyan-500/50 rounded-lg shadow-lg shadow-cyan-500/10">
                                <h3 className="font-exo text-lg text-cyan-300 mb-3">Saved Insights</h3>
                                <div className="space-y-4 max-h-64 overflow-y-auto pr-2">
                                    {savedInsights.map(insight => (
                                        <div key={insight.category}>
                                            <h4 className="font-bold text-cyan-200 text-sm font-exo">{insight.category}</h4>
                                            <ul className="list-disc list-inside space-y-1 mt-1 text-gray-300 text-sm">
                                                {insight.points.map((point, index) => (
                                                    <li key={index}>{point.text}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Right Column - Intel Report */}
                    <div className="lg:col-span-2 p-4 bg-gray-900/50 border border-cyan-600/20 rounded-lg overflow-y-auto">
                        <h3 className="font-exo text-xl text-white mb-4">Intelligence Dossier</h3>
                        <p className="text-gray-300 mb-4 italic text-sm md:text-base">{report.summary}</p>

                        <div className="border-t border-cyan-500/20 pt-4">
                            {report.professionalBackground?.points.length > 0 && <InsightSection insight={report.professionalBackground} sources={sources} highlightedIndices={highlightedIndices} setHighlightedIndices={setHighlightedIndices} onSaveInsight={handleSaveInsight} isSaved={isInsightSaved(report.professionalBackground.category)} />}
                            {report.recentActivities?.points.length > 0 && <InsightSection insight={report.recentActivities} sources={sources} highlightedIndices={highlightedIndices} setHighlightedIndices={setHighlightedIndices} onSaveInsight={handleSaveInsight} isSaved={isInsightSaved(report.recentActivities.category)} />}
                            {report.personalInterests?.points.length > 0 && <InsightSection insight={report.personalInterests} sources={sources} highlightedIndices={highlightedIndices} setHighlightedIndices={setHighlightedIndices} onSaveInsight={handleSaveInsight} isSaved={isInsightSaved(report.personalInterests.category)} />}
                            {report.discussionPoints?.points.length > 0 && <InsightSection insight={report.discussionPoints} sources={sources} highlightedIndices={highlightedIndices} setHighlightedIndices={setHighlightedIndices} onSaveInsight={handleSaveInsight} isSaved={isInsightSaved(report.discussionPoints.category)} />}

                            {sources.length > 0 && (
                               <div className="mt-6">
                                <h4 className="font-exo text-lg text-cyan-300 mb-2">Data Sources</h4>
                                <div className="space-y-2 max-h-40 overflow-y-auto pr-2">
                                    {sources.map((source, index) => source.web && (
                                        <a 
                                            href={source.web.uri} 
                                            target="_blank" 
                                            rel="noopener noreferrer" 
                                            key={index} 
                                            className={`flex items-center space-x-2 text-sm text-cyan-400 hover:text-white transition-all duration-300 group p-1 rounded-md ${highlightedIndices?.has(index) ? 'bg-cyan-900/50' : ''}`}
                                            onMouseEnter={() => setHighlightedIndices(new Set([index]))}
                                            onMouseLeave={() => setHighlightedIndices(null)}
                                        >
                                            <span className="flex-shrink-0">{getSourceIcon(source.web.uri).icon}</span>
                                            <span className="truncate group-hover:underline">{source.web.title || source.web.uri}</span>
                                        </a>
                                    ))}
                                </div>
                            </div>
                            )}

                             {report.rawText && !report.summary.startsWith("The model's response") && (
                                <details className="mt-6 group">
                                    <summary className="cursor-pointer text-gray-400 text-sm group-hover:text-white font-exo">Show Raw Model Output</summary>
                                    <div className="mt-2 p-3 bg-black/30 rounded">
                                        <p className="text-xs text-gray-500 whitespace-pre-wrap font-mono">{report.rawText}</p>
                                    </div>
                                </details>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PersonProfile;