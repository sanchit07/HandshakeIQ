import React from 'react';
import { Person, Dossier } from '../types';
import { RefreshIcon, SettingsIcon, LogoutIcon, CalendarIcon } from './icons/UIIcons';

interface SideMenuProps {
    isOpen: boolean;
    onClose: () => void;
    history: Person[];
    dossiers: Dossier[];
    onSelectPerson: (person: Person) => void;
    onRefreshPerson: (person: Person) => void;
    onGoToSettings: () => void;
    onGoToUpcomingMeetings: () => void;
    onLogout: () => void;
}

const SideMenu: React.FC<SideMenuProps> = ({ isOpen, onClose, history, dossiers, onSelectPerson, onRefreshPerson, onGoToSettings, onGoToUpcomingMeetings, onLogout }) => {
    
    const PersonListItem: React.FC<{person: Person, onRefresh?: (person: Person) => void}> = ({person, onRefresh}) => (
        <div className="flex items-center justify-between p-2 rounded-md hover:bg-cyan-900/50 group">
            <button onClick={() => onSelectPerson(person)} className="flex items-center space-x-3 text-left w-full">
                <img src={person.photoUrl} alt={person.name} className="w-8 h-8 rounded-full" />
                <div>
                    <p className="text-sm font-bold text-white">{person.name}</p>
                    <p className="text-xs text-cyan-300">{person.company}</p>
                </div>
            </button>
            {onRefresh && (
                <button onClick={() => onRefresh(person)} className="text-cyan-400 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" title="Refresh Intel">
                    <RefreshIcon />
                </button>
            )}
        </div>
    );

    const convertDossierToPerson = (dossier: Dossier): Person => ({
        id: dossier.id,
        name: dossier.personName,
        title: dossier.personTitle || '',
        company: dossier.personCompany || '',
        email: dossier.personEmail || '',
        photoUrl: dossier.personPhotoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(dossier.personName)}&background=0891b2&color=fff`,
        socialMediaLinks: dossier.socialMediaLinks || []
    });

    return (
        <>
            <div 
                className={`fixed inset-0 bg-black/60 z-[55] transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={onClose}
            ></div>
            <aside className={`fixed top-0 right-0 h-full w-[280px] sm:w-[320px] bg-gray-900/95 backdrop-blur-lg border-l border-cyan-500/20 z-[60]
                             transform transition-transform duration-300 ease-in-out shadow-2xl shadow-black/50 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
                <div className="h-full flex flex-col p-3 sm:p-4">
                    <h2 className="font-exo text-lg sm:text-xl text-white mb-4 sm:mb-6">Navigation</h2>
                    
                    <div className="flex-grow overflow-y-auto pr-2 space-y-6">
                        {/* Search History */}
                        <div>
                            <h3 className="text-cyan-300 font-bold mb-2 font-exo">Search History</h3>
                            {history.length > 0 ? (
                                <div className="space-y-1">
                                    {history.map(p => <PersonListItem key={`h-${p.id}`} person={p} onRefresh={onRefreshPerson} />)}
                                </div>
                            ) : (
                                <p className="text-sm text-gray-500">No recent searches.</p>
                            )}
                        </div>

                        {/* Saved Dossiers */}
                        <div>
                            <h3 className="text-cyan-300 font-bold mb-2 font-exo">Saved Dossiers</h3>
                            {dossiers.length > 0 ? (
                                <div className="space-y-1">
                                    {dossiers.map(d => <PersonListItem key={`d-${d.id}`} person={convertDossierToPerson(d)} />)}
                                </div>
                            ) : (
                                <p className="text-sm text-gray-500">No saved dossiers.</p>
                            )}
                        </div>
                    </div>
                    
                    <div className="flex-shrink-0 border-t border-cyan-500/20 pt-4 space-y-2">
                        <button onClick={onGoToUpcomingMeetings} className="w-full flex items-center space-x-3 px-4 py-2 text-cyan-200 hover:bg-cyan-800/60 rounded transition-colors text-left">
                            <CalendarIcon /> <span>Upcoming Meetings</span>
                        </button>
                        <button onClick={onGoToSettings} className="w-full flex items-center space-x-3 px-4 py-2 text-cyan-200 hover:bg-cyan-800/60 rounded transition-colors text-left">
                            <SettingsIcon /> <span>Settings</span>
                        </button>
                        <button onClick={onLogout} className="w-full flex items-center space-x-3 px-4 py-2 text-cyan-200 hover:bg-cyan-800/60 rounded transition-colors text-left">
                           <LogoutIcon /> <span>Logout</span>
                        </button>
                    </div>
                </div>
            </aside>
        </>
    );
};

export default SideMenu;