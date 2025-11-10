import React, { useState, useRef, useEffect, useCallback } from 'react';
import { extractTextFromImage } from '../services/geminiService';
import { CloseIcon } from './icons/UIIcons';
import { DataStreamLoader } from './loaders/NeonLoader';

interface CardScannerProps {
    onClose: (searchTerm?: string) => void;
}

const CardScanner: React.FC<CardScannerProps> = ({ onClose }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [extractedData, setExtractedData] = useState<{ name: string; company: string } | null>(null);
    const [editedName, setEditedName] = useState('');
    const [editedCompany, setEditedCompany] = useState('');

    const startCamera = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
            }
        } catch (err) {
            console.error("Error accessing camera:", err);
            setError("Could not access camera. Please check permissions and try again.");
        }
    }, []);

    useEffect(() => {
        startCamera();
        return () => {
            if (videoRef.current && videoRef.current.srcObject) {
                (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
            }
        };
    }, [startCamera]);

    const handleCapture = async () => {
        if (!videoRef.current || !canvasRef.current) return;
        setIsLoading(true);
        setError(null);
        
        const video = videoRef.current;
        const canvas = canvasRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        const context = canvas.getContext('2d');
        if (!context) return;
        
        context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
        const imageDataUrl = canvas.toDataURL('image/jpeg', 0.9);
        const base64Image = imageDataUrl.split(',')[1];
        
        try {
            const { name, company } = await extractTextFromImage(base64Image);
            
            if (!name && !company) {
                setError("No business card detected. Please ensure the card is clearly visible and try again.");
                setIsLoading(false);
                return;
            }
            
            if (!name || !company) {
                setError("Incomplete data extracted. Please review and edit the fields below.");
            }
            
            setExtractedData({ name, company });
            setEditedName(name);
            setEditedCompany(company);
        } catch (err) {
            setError("Failed to analyze image. Please ensure you're scanning a business card and try again.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleSearch = () => {
        if (!editedName.trim()) {
            setError("Please enter a name before searching.");
            return;
        }
        onClose(`${editedName.trim()} ${editedCompany.trim()}`);
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSearch();
        }
    };

    return (
        <div className="fixed inset-0 bg-black/95 z-70 flex flex-col items-center justify-center p-4 animate-fade-in">
            <button onClick={() => onClose()} className="absolute top-3 right-3 sm:top-4 sm:right-4 text-white z-20 p-2 rounded-full hover:bg-white/10 transition-colors">
                <CloseIcon />
            </button>
            
            {!extractedData ? (
                <>
                    <div className="relative w-full max-w-2xl h-auto aspect-[4/3] rounded-lg overflow-hidden border-2 border-cyan-500/50 shadow-2xl shadow-cyan-500/30 animate-pulse-glow">
                        <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
                        {isLoading && (
                            <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center p-4">
                                <DataStreamLoader text="Extracting contact data..." />
                            </div>
                        )}
                        <div className="scanner-animation"></div>
                        <div className="absolute inset-0 border-4 sm:border-8 border-black/30 pointer-events-none"></div>
                        <div className="absolute top-4 left-4 right-4 flex items-center justify-between">
                            <div className="w-8 h-8 border-t-2 border-l-2 border-cyan-400"></div>
                            <div className="w-8 h-8 border-t-2 border-r-2 border-cyan-400"></div>
                        </div>
                        <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between">
                            <div className="w-8 h-8 border-b-2 border-l-2 border-cyan-400"></div>
                            <div className="w-8 h-8 border-b-2 border-r-2 border-cyan-400"></div>
                        </div>
                    </div>
                    {error && <p className="mt-4 text-red-400 text-sm sm:text-base text-center px-4">{error}</p>}
                    <button
                        onClick={handleCapture}
                        disabled={isLoading}
                        className="mt-6 sm:mt-8 px-6 sm:px-8 py-3 sm:py-4 bg-cyan-600/80 text-white font-exo text-lg sm:text-xl rounded-full border-2 border-cyan-400 hover:bg-cyan-500 disabled:bg-gray-600 disabled:border-gray-500 transition-all duration-300 shadow-lg shadow-cyan-500/30 btn-glow hover:scale-105 active:scale-95"
                    >
                        {isLoading ? 'ANALYZING...' : 'SCAN CARD'}
                    </button>
                </>
            ) : (
                <div className="w-full max-w-lg bg-gray-900/90 border-2 border-cyan-500/50 rounded-lg p-6 sm:p-8 shadow-2xl shadow-cyan-500/30 animate-slide-up-fade">
                    <h2 className="text-xl sm:text-2xl font-exo text-cyan-300 mb-6 text-center">Extracted Data</h2>
                    
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-cyan-400 mb-2">Name</label>
                            <input
                                type="text"
                                value={editedName}
                                onChange={(e) => setEditedName(e.target.value)}
                                onKeyPress={handleKeyPress}
                                className="w-full px-4 py-3 bg-gray-800/50 border border-cyan-500/30 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-cyan-400"
                                placeholder="Enter name"
                                autoFocus
                            />
                        </div>
                        
                        <div>
                            <label className="block text-sm font-medium text-cyan-400 mb-2">Company</label>
                            <input
                                type="text"
                                value={editedCompany}
                                onChange={(e) => setEditedCompany(e.target.value)}
                                onKeyPress={handleKeyPress}
                                className="w-full px-4 py-3 bg-gray-800/50 border border-cyan-500/30 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-cyan-400"
                                placeholder="Enter company (optional)"
                            />
                        </div>
                    </div>
                    
                    {error && <p className="mt-4 text-red-400 text-sm text-center">{error}</p>}
                    
                    <div className="mt-6 space-y-3">
                        <button
                            onClick={handleSearch}
                            className="w-full px-6 py-3 bg-cyan-600/80 text-white font-exo text-lg rounded-lg border-2 border-cyan-400 hover:bg-cyan-500 transition-all duration-300 shadow-lg shadow-cyan-500/30 btn-glow hover:scale-105 active:scale-95"
                        >
                            Search Intelligence
                        </button>
                        
                        <button
                            onClick={() => {
                                setExtractedData(null);
                                setEditedName('');
                                setEditedCompany('');
                                setError(null);
                            }}
                            className="w-full px-6 py-3 bg-gray-700/50 text-gray-300 font-exo rounded-lg border border-gray-500/50 hover:bg-gray-600/50 hover:text-white transition-all duration-300"
                        >
                            Scan Again
                        </button>
                    </div>
                    
                    <p className="mt-4 text-xs text-gray-500 text-center">
                        Press Enter to search or edit the fields above
                    </p>
                </div>
            )}
            
            <canvas ref={canvasRef} className="hidden" />
             <style>{`
                @keyframes scan-line {
                    0% { top: 0; }
                    100% { top: 100%; }
                }
                .scanner-animation::after {
                    content: '';
                    position: absolute;
                    left: 0;
                    right: 0;
                    height: 3px;
                    background: #06b6d4;
                    box-shadow: 0 0 10px 2px #06b6d4;
                    animation: scan-line 2.5s infinite ease-in-out;
                }
             `}</style>
        </div>
    );
};

export default CardScanner;