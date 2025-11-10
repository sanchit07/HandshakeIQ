import React, { useState, useRef, useEffect, useCallback } from 'react';
import { extractTextFromImage } from '../services/geminiService';
import { CloseIcon } from './icons/UIIcons';

interface CardScannerProps {
    onClose: (searchTerm?: string) => void;
}

const CardScanner: React.FC<CardScannerProps> = ({ onClose }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
            onClose(`${name} ${company}`);
        } catch (err) {
            setError("Failed to analyze image. Please try again.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center animate-fade-in">
            <button onClick={() => onClose()} className="absolute top-4 right-4 text-white z-20 p-2 rounded-full hover:bg-white/10 transition-colors">
                <CloseIcon />
            </button>
            <div className="relative w-full max-w-2xl h-auto aspect-[4/3] rounded-lg overflow-hidden border-2 border-cyan-500/50 shadow-2xl shadow-cyan-500/30">
                <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
                {isLoading && (
                    <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center">
                        <div className="relative w-24 h-24">
                            <div className="absolute inset-0 border-4 border-cyan-500/30 rounded-full"></div>
                            <div className="absolute inset-0 border-t-4 border-cyan-400 rounded-full animate-spin"></div>
                        </div>
                        <p className="mt-4 font-exo text-lg text-cyan-300">EXTRACTING DATA...</p>
                    </div>
                )}
                 <div className="scanner-animation"></div>
                 <div className="absolute inset-0 border-8 border-black/30 pointer-events-none"></div>
            </div>
            {error && <p className="mt-4 text-red-400">{error}</p>}
            <button
                onClick={handleCapture}
                disabled={isLoading}
                className="mt-8 px-8 py-4 bg-cyan-600/80 text-white font-exo text-xl rounded-full border-2 border-cyan-400 hover:bg-cyan-500 disabled:bg-gray-600 transition-all duration-300 shadow-lg shadow-cyan-500/30 btn-glow"
            >
                {isLoading ? 'ANALYZING...' : 'SCAN CARD'}
            </button>
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