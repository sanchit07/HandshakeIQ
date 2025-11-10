import React, { useState, useCallback } from 'react';
import LoginScreen from './components/LoginScreen';
import Dashboard from './components/Dashboard';
import PersonProfile from './components/PersonProfile';
import SettingsScreen from './components/SettingsScreen';
import CardScanner from './components/CardScanner';
import SideMenu from './components/SideMenu';
import UpcomingMeetings from './components/UpcomingMeetings';
import { Person, CalendarAttendee } from './types';
import { MOCK_PEOPLE, MOCK_MEETINGS } from './constants';
import { MovingWallsLogo, HandshakeIQLogo } from './components/icons/Logos';
import { MenuIcon } from './components/icons/UIIcons';
import { useAuth } from './client/hooks/useAuth';

const App: React.FC = () => {
  const { user, isLoading, isAuthenticated, isGuest, hasError } = useAuth();
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [view, setView] = useState<'dashboard' | 'profile' | 'settings' | 'scanner' | 'login' | 'upcoming-meetings'>('dashboard');
  const [scannedSearchTerm, setScannedSearchTerm] = useState<string>('');
  const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
  const [searchHistory, setSearchHistory] = useState<Person[]>([]);
  const [savedDossiers, setSavedDossiers] = useState<Person[]>([]);
  const [guestMode, setGuestMode] = useState<boolean>(false);

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
  
  const handleContinueAsGuest = useCallback(() => {
    setGuestMode(true);
    setView('dashboard');
  }, []);

  const handleSaveDossier = useCallback((person: Person) => {
    // Require authentication for saving
    if (guestMode || !isAuthenticated) {
      // Show login prompt and clear guest mode
      alert('Please sign in to save dossiers. This feature requires authentication.');
      setGuestMode(false);
      setView('login');
      return;
    }
    
    setSavedDossiers(prev => {
        if (prev.find(p => p.id === person.id)) {
            return prev; // Already saved
        }
        return [...prev, person];
    });
  }, [guestMode, isAuthenticated]);

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
  
  const handleGoToUpcomingMeetings = useCallback(() => {
    setView('upcoming-meetings');
    setIsMenuOpen(false);
  }, []);
  
  const handleSelectAttendee = useCallback((attendee: CalendarAttendee) => {
    // Convert CalendarAttendee to Person for profile view
    const person: Person = {
      id: attendee.email || `attendee-${Date.now()}`,
      name: attendee.displayName || attendee.email?.split('@')[0] || 'Unknown',
      email: attendee.email || '',
      title: '', // Will be filled by AI intelligence report
      company: attendee.email?.split('@')[1] || '',
      photoUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(attendee.displayName || attendee.email || 'U')}&background=0891b2&color=fff`
    };
    setSelectedPerson(person);
    setView('profile');
    setSearchHistory(prev => [person, ...prev.filter(p => p.id !== person.id)].slice(0, 10));
  }, []);

  const handleBackToDashboard = useCallback(() => {
    setView('dashboard');
    // Keep person selected for a moment to allow for smooth transition out
    setTimeout(() => setSelectedPerson(null), 500);
  }, []);

  const isProfileVisible = view === 'profile';
  const isSettingsVisible = view === 'settings';
  const isUpcomingMeetingsVisible = view === 'upcoming-meetings';
  const isLoginVisible = view === 'login';
  
  // Show app content if authenticated OR in guest mode
  const showAppContent = isAuthenticated || guestMode;
  
  // Show login screen if loading is done and user hasn't authenticated or chosen guest mode
  // Also show login if there's an error (network/server issue)
  const showLoginScreen = !isLoading && !showAppContent && !hasError;
  
  // If there's a network/server error, show an error message
  const showError = !isLoading && hasError;

  return (
    <div className="min-h-screen text-cyan-200 animated-background">
      <div className="relative isolate min-h-screen flex flex-col p-4 sm:p-6 lg:p-8">
        <header className="flex justify-between items-center mb-6 z-30 px-4 py-2 bg-black/20 backdrop-blur-sm border-b border-cyan-500/10 rounded-lg">
          <div className="flex items-center space-x-4">
            <HandshakeIQLogo />
            <h1 className="font-exo text-xl md:text-2xl font-bold text-white tracking-widest">HandshakeIQ</h1>
          </div>
          <div className="flex items-center space-x-4">
            {showAppContent && (
              <>
                {guestMode && (
                  <button 
                    onClick={() => {
                      setGuestMode(false);
                      setView('login');
                    }}
                    className="text-xs px-3 py-1.5 bg-cyan-600/80 hover:bg-cyan-500 rounded-md text-white font-medium transition-colors"
                  >
                    Sign In
                  </button>
                )}
                {isAuthenticated && (
                  <button onClick={() => setIsMenuOpen(true)} className="text-cyan-400 hover:text-white transition-colors p-2 rounded-full hover:bg-cyan-500/20" aria-label="Open Menu">
                    <MenuIcon />
                  </button>
                )}
              </>
            )}
            <div className="flex items-center space-x-2">
              <span className="text-xs text-gray-400 hidden sm:inline">Powered by</span>
              <MovingWallsLogo />
            </div>
          </div>
        </header>

        <main className={`flex-grow overflow-hidden transition-transform duration-500 ease-in-out ${isMenuOpen ? 'translate-x-[-280px]' : ''}`}>
          {showError ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center p-8 bg-red-900/20 border border-red-500/30 rounded-lg max-w-md">
                <h2 className="font-exo text-2xl font-bold text-red-400 mb-4">Connection Error</h2>
                <p className="text-red-300 mb-6">Unable to connect to the server. You can try again or continue as guest.</p>
                <div className="flex flex-col gap-3">
                  <button
                    onClick={() => window.location.reload()}
                    className="px-6 py-3 bg-cyan-600/80 hover:bg-cyan-500 rounded-lg text-white font-medium transition-colors"
                  >
                    Retry Connection
                  </button>
                  <button
                    onClick={handleContinueAsGuest}
                    className="px-6 py-3 border border-gray-500/30 bg-gray-800/20 rounded-lg hover:bg-gray-700/40 hover:border-gray-400 transition-all text-gray-300 hover:text-white"
                  >
                    Continue as Guest
                  </button>
                </div>
              </div>
            </div>
          ) : showLoginScreen || isLoginVisible ? (
            <LoginScreen onContinueAsGuest={handleContinueAsGuest} />
          ) : showAppContent ? (
            <div className="relative w-full h-full">
               <div className={`transition-all duration-500 ease-in-out ${isProfileVisible || isSettingsVisible || isUpcomingMeetingsVisible ? 'transform -translate-x-full opacity-0 scale-95' : 'transform translate-x-0 opacity-100 scale-100'}`}>
                <Dashboard
                  meetings={MOCK_MEETINGS}
                  people={MOCK_PEOPLE}
                  onSelectPerson={handleSelectPerson}
                  onOpenScanner={handleOpenScanner}
                  onGoToSettings={handleGoToSettings}
                  onGoToUpcomingMeetings={handleGoToUpcomingMeetings}
                  onSelectAttendee={handleSelectAttendee}
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
                <SettingsScreen userEmail={(user as any)?.email || ''} onBack={handleBackToDashboard} />
              </div>
              <div
                className={`absolute top-0 left-0 w-full h-full transition-all duration-500 ease-in-out ${
                  isUpcomingMeetingsVisible ? 'transform translate-x-0 opacity-100 scale-100' : 'transform translate-x-full opacity-0 scale-95'
                }`}
              >
                <UpcomingMeetings onBack={handleBackToDashboard} onSelectAttendee={handleSelectAttendee} />
              </div>
            </div>
          ) : null}
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
                onGoToUpcomingMeetings={handleGoToUpcomingMeetings}
                onLogout={handleLogout}
            />
        )}
      </div>
    </div>
  );
};

export default App;