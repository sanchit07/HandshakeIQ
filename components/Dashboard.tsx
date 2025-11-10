import React, { useState, useEffect, useCallback } from 'react';
import { Person, Meeting, CalendarEvent, CalendarAttendee } from '../types';
import { SearchIcon, CalendarIcon, CameraIcon } from './icons/UIIcons';
import { GoogleIcon, ZohoIcon, MicrosoftIcon } from './icons/BrandIcons';
import { useTodayTomorrowEvents } from '../client/hooks/useCalendar';
import { useAuth } from '../client/hooks/useAuth';
import axios from 'axios';

interface DashboardProps {
  meetings: Meeting[];
  people: Person[];
  onSelectPerson: (person: Person) => void;
  onOpenScanner: () => void;
  onGoToSettings: () => void;
  onGoToUpcomingMeetings: () => void;
  onSelectAttendee: (attendee: CalendarAttendee) => void;
  initialSearch: string;
}

interface SearchResult extends Person {
  linkedInUrl?: string;
  sources?: {
    linkedin?: string;
    instagram?: string;
    twitter?: string;
    tiktok?: string;
    facebook?: string;
    blog?: string[];
    news?: string[];
    other?: string[];
  };
  allLinks?: string[];
}

const SearchBar: React.FC<{ 
    people: Person[]; 
    onSelectPerson: (person: Person) => void; 
    onOpenScanner: () => void;
    initialSearch: string;
}> = ({ people, onSelectPerson, onOpenScanner, initialSearch }) => {
    const [query, setQuery] = useState('');
    const [isFocused, setIsFocused] = useState(false);
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    useEffect(() => {
        if (initialSearch) {
            setQuery(initialSearch);
            setIsFocused(true);
        }
    }, [initialSearch]);

    // Debounced search effect
    useEffect(() => {
        if (!query || query.length < 2) {
            setSearchResults([]);
            setSearchError(null);
            return;
        }

        const timeoutId = setTimeout(async () => {
            setIsSearching(true);
            setSearchError(null);
            
            try {
                const response = await axios.get('/api/search/person', {
                    params: { name: query },
                });
                
                setSearchResults(response.data);
            } catch (error) {
                console.error('Search error:', error);
                setSearchError('Search temporarily unavailable. Please try again.');
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        }, 500); // 500ms debounce

        return () => clearTimeout(timeoutId);
    }, [query]);

    const handleSelect = (person: SearchResult) => {
        setQuery('');
        onSelectPerson(person);
        setIsFocused(false);
        setSearchResults([]);
    };

    const displayResults = searchResults.length > 0 ? searchResults : [];

    return (
        <div className="relative w-full max-w-2xl mx-auto px-3 sm:px-0 animate-slide-up-fade" style={{animationDelay: '100ms'}}>
            <div className="relative">
                <div className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 pointer-events-none text-cyan-400">
                    <SearchIcon />
                </div>
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setTimeout(() => setIsFocused(false), 200)}
                    placeholder="Search for anyone by name, company, or designation..."
                    className="w-full pl-10 sm:pl-12 pr-10 sm:pr-12 py-2.5 sm:py-3 bg-gray-900/50 border border-cyan-500/30 rounded-full text-white text-sm sm:text-base placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-cyan-400 focus:shadow-cyan-500/30 transition-all duration-300 shadow-lg shadow-cyan-500/10 animate-pulse-glow"
                />
                <button 
                    onClick={onOpenScanner} 
                    className="absolute right-3 sm:right-4 top-1/2 -translate-y-1/2 text-cyan-400 hover:text-white transition-all duration-300 p-1 rounded-full hover:bg-cyan-500/20 hover:scale-110"
                    aria-label="Scan business card"
                >
                    <CameraIcon />
                </button>
                {query && (
                    <div className="absolute inset-0 rounded-full border border-cyan-400 animate-pulse pointer-events-none"></div>
                )}
            </div>
            {isFocused && query.length >= 2 && (
                <div className="z-10 w-full mt-2 bg-gray-900/95 backdrop-blur-md border border-cyan-500/40 rounded-lg shadow-2xl shadow-cyan-500/20 max-h-80 overflow-y-auto animate-slide-down-fade">
                    {isSearching ? (
                        <div className="p-6 text-center">
                            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400"></div>
                            <p className="text-cyan-300 text-sm mt-3">Searching the web...</p>
                        </div>
                    ) : searchError ? (
                        <div className="p-4 text-center">
                            <p className="text-red-400 text-sm">{searchError}</p>
                        </div>
                    ) : displayResults.length > 0 ? (
                        <>
                            <div className="px-3 py-2 border-b border-cyan-500/20 bg-cyan-900/20">
                                <p className="text-xs sm:text-sm text-cyan-300 font-exo">
                                    Found {displayResults.length} unique {displayResults.length !== 1 ? 'people' : 'person'} from web search
                                </p>
                            </div>
                            {displayResults.map((person, index) => (
                                <div 
                                    key={person.id} 
                                    onMouseDown={() => handleSelect(person)} 
                                    className="flex items-center p-2 sm:p-3 hover:bg-cyan-900/50 cursor-pointer transition-all duration-300 border-b border-cyan-500/10 last:border-b-0 group"
                                    style={{animationDelay: `${index * 50}ms`}}
                                >
                                    <img 
                                        src={person.photoUrl} 
                                        alt={person.name} 
                                        className="w-10 h-10 sm:w-12 sm:h-12 rounded-full mr-3 sm:mr-4 border-2 border-cyan-600/50 group-hover:border-cyan-400 group-hover:shadow-lg group-hover:shadow-cyan-500/30 transition-all duration-300" 
                                        onError={(e) => {
                                            const target = e.target as HTMLImageElement;
                                            target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(person.name)}&background=0D1117&color=22D3EE&size=200`;
                                        }}
                                    />
                                    <div className="flex-1 min-w-0">
                                        <p className="font-bold text-white text-sm sm:text-base truncate">{person.name}</p>
                                        <p className="text-xs sm:text-sm text-cyan-300 truncate">{person.title} at {person.company}</p>
                                        {person.linkedInUrl && (
                                            <p className="text-xs text-gray-400 truncate mt-0.5">LinkedIn Profile Found</p>
                                        )}
                                    </div>
                                    <div className="ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <span className="text-cyan-400">→</span>
                                    </div>
                                </div>
                            ))}
                        </>
                    ) : (
                        <div className="p-4 text-center">
                            <p className="text-gray-400 text-sm sm:text-base">No results found for "{query}"</p>
                            <p className="text-xs text-gray-500 mt-1">Try a different name or add company info</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};


const formatDateTime = (dateString: string) => {
  const date = new Date(dateString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = date.toDateString() === today.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  if (isToday) return `Today, ${timeStr}`;
  if (isTomorrow) return `Tomorrow, ${timeStr}`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
};

const CalendarMeetingList: React.FC<{ 
  events: CalendarEvent[]; 
  onSelectAttendee: (attendee: CalendarAttendee) => void;
  onGoToUpcomingMeetings: () => void;
}> = ({ events, onSelectAttendee, onGoToUpcomingMeetings }) => {
  if (events.length === 0) return null;

  return (
    <div className="mt-6 sm:mt-8 animate-slide-up-fade" style={{animationDelay: '200ms'}}>
      <div className="flex items-center justify-between mb-3 sm:mb-4 px-2 sm:px-0">
        <h2 className="text-lg sm:text-xl font-bold text-white font-exo flex items-center gap-2">
          <CalendarIcon />
          Today & Tomorrow
        </h2>
        <button 
          onClick={onGoToUpcomingMeetings}
          className="text-cyan-400 hover:text-white text-xs sm:text-sm font-exo transition-colors"
        >
          View All Meetings →
        </button>
      </div>

      <div className="space-y-3 sm:space-y-4">
        {events.map((event, idx) => (
          <div 
            key={event.id} 
            className="bg-gray-900/50 border border-cyan-500/30 rounded-lg p-3 sm:p-4 hover:bg-gray-900/70 hover:border-cyan-500/50 transition-all duration-300 shadow-lg shadow-cyan-500/5 animate-slide-up-fade"
            style={{animationDelay: `${(idx + 1) * 100}ms`}}
          >
            <div className="flex items-start justify-between mb-2">
              <div className="flex-1 min-w-0 pr-2">
                <h3 className="text-sm sm:text-base font-bold text-white truncate">{event.summary}</h3>
                <p className="text-xs sm:text-sm text-cyan-300 mt-1">{formatDateTime(event.start)}</p>
                {event.location && (
                  <p className="text-xs text-gray-400 mt-1 truncate">📍 {event.location}</p>
                )}
              </div>
              <GoogleIcon className="flex-shrink-0" />
            </div>

            {event.attendees && event.attendees.length > 0 && (
              <div className="mt-3 pt-3 border-t border-cyan-500/20">
                <p className="text-xs text-gray-400 mb-2">Attendees ({event.attendees.length}):</p>
                <div className="flex flex-wrap gap-2">
                  {event.attendees.slice(0, 5).map((attendee, i) => (
                    <button
                      key={i}
                      onClick={() => onSelectAttendee(attendee)}
                      className="flex items-center gap-2 px-2 sm:px-3 py-1.5 bg-cyan-900/30 hover:bg-cyan-800/50 rounded-full transition-all duration-200 group border border-cyan-500/20 hover:border-cyan-400/50"
                    >
                      <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-cyan-700 flex items-center justify-center text-[10px] sm:text-xs font-bold text-white">
                        {attendee.displayName ? attendee.displayName.charAt(0).toUpperCase() : '?'}
                      </div>
                      <span className="text-xs text-cyan-300 group-hover:text-white transition-colors truncate max-w-[120px] sm:max-w-none">
                        {attendee.displayName || attendee.email}
                      </span>
                    </button>
                  ))}
                  {event.attendees.length > 5 && (
                    <div className="flex items-center px-2 sm:px-3 py-1.5 text-xs text-gray-400">
                      +{event.attendees.length - 5} more
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const MeetingList: React.FC<{ meetings: Meeting[]; onSelectPerson: (person: Person) => void; onGoToSettings: () => void; }> = ({ meetings, onSelectPerson, onGoToSettings }) => {
    if (meetings.length === 0) return null;
    
    return (
        <div className="mt-6 sm:mt-8 animate-slide-up-fade" style={{animationDelay: '200ms'}}>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-3 sm:mb-4 px-2 sm:px-0 font-exo flex items-center gap-2">
                <CalendarIcon />
                Today & Tomorrow
            </h2>

            <div className="space-y-3 sm:space-y-4">
                {meetings.map((meeting, idx) => (
                    <div key={meeting.id} className="bg-gray-900/50 border border-cyan-500/30 rounded-lg p-3 sm:p-4 hover:bg-gray-900/70 hover:border-cyan-500/50 transition-all duration-300 shadow-lg shadow-cyan-500/5 animate-slide-up-fade" style={{animationDelay: `${(idx+1)*100}ms`}}>
                        <div className="flex items-start justify-between mb-2">
                            <div>
                                <h3 className="text-sm sm:text-base font-bold text-white">{meeting.title}</h3>
                                <p className="text-xs sm:text-sm text-cyan-300 mt-1">{meeting.time}</p>
                            </div>
                            {meeting.platform === 'google' && <GoogleIcon />}
                            {meeting.platform === 'zoom' && <ZohoIcon />}
                            {meeting.platform === 'teams' && <MicrosoftIcon />}
                        </div>

                        <div className="mt-3 pt-3 border-t border-cyan-500/20">
                            <p className="text-xs text-gray-400 mb-2">Participants:</p>
                            <div className="flex flex-wrap gap-2">
                                {meeting.participants.map((person, i) => (
                                    <button key={i} onClick={() => onSelectPerson(person)} className="flex items-center gap-2 px-2 sm:px-3 py-1.5 bg-cyan-900/30 hover:bg-cyan-800/50 rounded-full transition-all duration-200 group border border-cyan-500/20 hover:border-cyan-400/50">
                                        <img src={person.photoUrl} alt={person.name} className="w-5 h-5 sm:w-6 sm:h-6 rounded-full border border-cyan-600/50 group-hover:border-cyan-400 transition-colors" />
                                        <span className="text-xs text-cyan-300 group-hover:text-white transition-colors truncate">{person.name}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};


const Dashboard: React.FC<DashboardProps> = ({ meetings, people, onSelectPerson, onOpenScanner, onGoToSettings, onGoToUpcomingMeetings, onSelectAttendee, initialSearch }) => {
  const { user, isLoading: authLoading } = useAuth();
  const { data: calendarEvents, isLoading: calendarLoading } = useTodayTomorrowEvents(!!user);

  return (
    <div className="max-w-4xl mx-auto p-2">
      <SearchBar people={people} onSelectPerson={onSelectPerson} onOpenScanner={onOpenScanner} initialSearch={initialSearch} />
      
      {user && !calendarLoading && calendarEvents && calendarEvents.length > 0 ? (
        <CalendarMeetingList 
          events={calendarEvents} 
          onSelectAttendee={onSelectAttendee}
          onGoToUpcomingMeetings={onGoToUpcomingMeetings}
        />
      ) : user && meetings.length > 0 ? (
        <MeetingList meetings={meetings} onSelectPerson={onSelectPerson} onGoToSettings={onGoToSettings} />
      ) : null}
    </div>
  );
};

export default Dashboard;
