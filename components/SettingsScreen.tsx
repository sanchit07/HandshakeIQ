import React from 'react';
import { BackIcon } from './icons/UIIcons';
import { GoogleIcon, ZohoIcon, MicrosoftIcon } from './icons/BrandIcons';


interface SettingsScreenProps {
    onBack: () => void;
    userEmail: string;
}

const SettingsSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="p-6 bg-gray-900/50 border border-cyan-600/20 rounded-lg">
        <h3 className="font-exo text-lg text-cyan-300 mb-4 border-b border-cyan-500/20 pb-2">{title}</h3>
        <div className="space-y-4">
            {children}
        </div>
    </div>
);

const SettingsScreen: React.FC<SettingsScreenProps> = ({ onBack, userEmail }) => {
    return (
        <div className="h-full flex flex-col p-4 bg-black/30 border border-cyan-500/20 rounded-lg backdrop-blur-md overflow-y-auto animate-fade-in">
            <div className="flex-shrink-0 flex items-center justify-between mb-6">
                <button onClick={onBack} className="flex items-center space-x-2 text-cyan-300 hover:text-white transition-colors">
                    <BackIcon />
                    <span className="font-bold font-exo">Back to Dashboard</span>
                </button>
                <h2 className="font-exo text-2xl text-white">Settings</h2>
            </div>

            <div className="max-w-2xl mx-auto w-full space-y-6">
                <SettingsSection title="Calendar Sync">
                     <p className="text-sm text-gray-400">Manage calendars associated with <span className="font-bold text-cyan-300">{userEmail}</span>.</p>
                    <div className="flex justify-between items-center p-3 bg-gray-900/40 rounded-md">
                        <div className="flex items-center space-x-3">
                            <GoogleIcon />
                            <div>
                                <p className="font-bold text-white">Google Calendar</p>
                                <p className="text-sm text-green-400">Synced</p>
                            </div>
                        </div>
                        <button className="px-4 py-1 text-sm text-yellow-300 border border-yellow-400/50 rounded-full hover:bg-yellow-900/50 transition-colors btn-glow">
                            Unsync
                        </button>
                    </div>
                     <div className="flex justify-between items-center p-3 bg-gray-900/40 rounded-md">
                        <div className="flex items-center space-x-3">
                            <ZohoIcon />
                            <div>
                                <p className="font-bold text-white">Zoho Calendar</p>
                                <p className="text-sm text-gray-400">Not Synced</p>
                            </div>
                        </div>
                        <button className="px-4 py-1 text-sm text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors btn-glow">
                            Sync
                        </button>
                    </div>
                     <div className="flex justify-between items-center p-3 bg-gray-900/40 rounded-md">
                        <div className="flex items-center space-x-3">
                            <MicrosoftIcon />
                            <div>
                                <p className="font-bold text-white">Microsoft Calendar</p>
                                <p className="text-sm text-gray-400">Not Synced</p>
                            </div>
                        </div>
                        <button className="px-4 py-1 text-sm text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors btn-glow">
                            Sync
                        </button>
                    </div>
                </SettingsSection>

                <SettingsSection title="Account Security">
                    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); alert('Password updated successfully!'); }}>
                         <input type="password" placeholder="Current Password" required className="w-full px-4 py-2 bg-gray-900/50 border border-cyan-500/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-cyan-400" />
                         <input type="password" placeholder="New Password" required className="w-full px-4 py-2 bg-gray-900/50 border border-cyan-500/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-cyan-400" />
                         <input type="password" placeholder="Confirm New Password" required className="w-full px-4 py-2 bg-gray-900/50 border border-cyan-500/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-cyan-400" />
                         <button type="submit" className="w-full py-2 font-bold text-slate-900 bg-cyan-600 hover:bg-cyan-500 rounded-lg transition-colors btn-glow font-exo">
                            Change Password
                        </button>
                    </form>
                </SettingsSection>
            </div>
        </div>
    );
};

export default SettingsScreen;