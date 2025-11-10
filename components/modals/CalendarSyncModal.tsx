import React from 'react';
import { GoogleIcon, ZohoIcon, MicrosoftIcon } from '../icons/BrandIcons';

interface CalendarSyncModalProps {
    onSync: () => void;
    onSkip: () => void;
    userEmail: string;
}

const CalendarSyncModal: React.FC<CalendarSyncModalProps> = ({ onSync, onSkip, userEmail }) => {
    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
            <div className="w-full max-w-lg p-8 m-4 bg-gray-900 border border-cyan-500/30 rounded-2xl shadow-2xl shadow-cyan-500/20 transform animate-slide-up-fade">
                <h2 className="font-exo text-2xl text-white text-center">Synchronize Calendars</h2>
                <p className="mt-4 text-center text-cyan-300">
                    Connect your calendar to automatically identify meeting attendees. We'll sync calendars associated with:
                </p>
                <p className="mt-2 text-center text-lg font-bold text-white">{userEmail}</p>

                <div className="mt-6 space-y-3">
                    <button onClick={onSync} className="w-full flex items-center justify-center space-x-3 py-3 bg-cyan-900/40 hover:bg-cyan-800/60 rounded-lg transition-colors btn-glow"><GoogleIcon /> <span>Sync Google Calendar</span></button>
                    <button onClick={onSync} className="w-full flex items-center justify-center space-x-3 py-3 bg-cyan-900/40 hover:bg-cyan-800/60 rounded-lg transition-colors btn-glow"><MicrosoftIcon /> <span>Sync Microsoft Calendar</span></button>
                    <button onClick={onSync} className="w-full flex items-center justify-center space-x-3 py-3 bg-cyan-900/40 hover:bg-cyan-800/60 rounded-lg transition-colors btn-glow"><ZohoIcon /> <span>Sync Zoho Calendar</span></button>
                </div>

                <div className="mt-8 text-center">
                    <button 
                        onClick={onSkip}
                        className="px-8 py-2 font-exo text-sm text-cyan-300 hover:underline"
                    >
                        Maybe Later
                    </button>
                </div>
            </div>
        </div>
    );
};

export default CalendarSyncModal;