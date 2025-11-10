import React, { useState, useCallback } from 'react';
import LoginScreen from './components/LoginScreen';
import Dashboard from './components/Dashboard';
import PersonProfile from './components/PersonProfile';
import SettingsScreen from './components/SettingsScreen';
import CardScanner from './components/CardScanner';
import SideMenu from './components/SideMenu';
import { Person } from './types';
import { MOCK_PEOPLE, MOCK_MEETINGS } from './constants';
import { MovingWallsLogo, HandshakeIQLogo } from './components/icons/Logos';
import { MenuIcon } from './components/icons/UIIcons';
import { useAuth } from './client/hooks/useAuth';

const App: React.FC = () => {
  const { user, isLoading, isAuthenticated } = useAuth();
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [view, setView] = useState<'dashboard' | 'profile' | 'settings' | 'scanner'>('dashboard');
  const [scannedSearchTerm, setScannedSearchTerm] = useState<string>('');
  const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
  const [searchHistory, setSearchHistory] = useState<Person[]>([]);
  const [savedDossiers, setSavedDossiers] = useState<Person[]>([]);

  const handleLogout = useCallback(() => {
    window.location.href = '/api/logout';
  }, []);

  const handleSelectPerson = useCallback((person: Person) => {
    setSelectedPerson(person);
    setView('profile');
    setIsMenuOpen(false);
    // Add to history, avoiding duplicates and keeping it recent
    setSearchHistory(prev => [person, ...prev.filter(p => p.id !== person.id)].slice(0, 10));
  }, []);
  
  const handleSaveDossier = useCallback((person: Person) => {
    setSavedDossiers(prev => {
        if (prev.find(p => p.id === person.id)) {
            return prev; // Already saved
        }
        return [...prev, person];
    });
  }, []);

  const handleOpenScanner = useCallback(() => setView('scanner'), []);
  const handleCloseScanner = useCallback((searchTerm?: string) => {
      if (searchTerm) {
          setScannedSearchTerm(searchTerm);
      }
      setView('dashboard');
  }, []);
  
  const handleGoToSettings = useCallback(() => {
    setView('settings');
    setIsMenuOpen(false);
  }, []);

  const handleBackToDashboard = useCallback(() => {
    setView('dashboard');
    // Keep person selected for a moment to allow for smooth transition out
    setTimeout(() => setSelectedPerson(null), 500);
  }, []);

  const isProfileVisible = view === 'profile';
  const isSettingsVisible = view === 'settings';

  return (
    <div className="min-h-screen text-cyan-200 animated-background">
      <div className="relative isolate min-h-screen flex flex-col p-4 sm:p-6 lg:p-8">
        <header className="flex justify-between items-center mb-6 z-30 px-4 py-2 bg-black/20 backdrop-blur-sm border-b border-cyan-500/10 rounded-lg">
          <div className="flex items-center space-x-4">
            <HandshakeIQLogo />
            <h1 className="font-exo text-xl md:text-2xl font-bold text-white tracking-widest">HandshakeIQ</h1>
          </div>
          <div className="flex items-center space-x-4">
            {isAuthenticated && (
              <button onClick={() => setIsMenuOpen(true)} className="text-cyan-400 hover:text-white transition-colors p-2 rounded-full hover:bg-cyan-500/20" aria-label="Open Menu">
                <MenuIcon />
              </button>
            )}
            <div className="flex items-center space-x-2">
              <span className="text-xs text-gray-400 hidden sm:inline">Powered by</span>
              <MovingWallsLogo />
            </div>
          </div>
        </header>

        <main className={`flex-grow overflow-hidden transition-transform duration-500 ease-in-out ${isMenuOpen ? 'translate-x-[-280px]' : ''}`}>
          {isLoading || !isAuthenticated ? (
            <LoginScreen />
          ) : (
            <div className="relative w-full h-full">
               <div className={`transition-all duration-500 ease-in-out ${isProfileVisible || isSettingsVisible ? 'transform -translate-x-full opacity-0 scale-95' : 'transform translate-x-0 opacity-100 scale-100'}`}>
                <Dashboard
                  meetings={MOCK_MEETINGS}
                  people={MOCK_PEOPLE}
                  onSelectPerson={handleSelectPerson}
                  onOpenScanner={handleOpenScanner}
                  onGoToSettings={handleGoToSettings}
                  initialSearch={scannedSearchTerm}
                />
              </div>
              <div
                className={`absolute top-0 left-0 w-full h-full transition-all duration-500 ease-in-out ${
                  isProfileVisible ? 'transform translate-x-0 opacity-100 scale-100' : 'transform translate-x-full opacity-0 scale-95'
                }`}
              >
                {selectedPerson && <PersonProfile person={selectedPerson} onBack={handleBackToDashboard} onSave={handleSaveDossier} />}
              </div>
               <div
                className={`absolute top-0 left-0 w-full h-full transition-all duration-500 ease-in-out ${
                  isSettingsVisible ? 'transform translate-x-0 opacity-100 scale-100' : 'transform translate-x-full opacity-0 scale-95'
                }`}
              >
                <SettingsScreen userEmail={user?.email || ''} onBack={handleBackToDashboard} />
              </div>
            </div>
          )}
        </main>
        {view === 'scanner' && <CardScanner onClose={handleCloseScanner} />}
        {isAuthenticated && (
            <SideMenu 
                isOpen={isMenuOpen}
                onClose={() => setIsMenuOpen(false)}
                history={searchHistory}
                dossiers={savedDossiers}
                onSelectPerson={handleSelectPerson}
                onRefreshPerson={handleSelectPerson} // For now, refresh just re-selects
                onGoToSettings={handleGoToSettings}
                onLogout={handleLogout}
            />
        )}
      </div>
    </div>
  );
};

export default App;