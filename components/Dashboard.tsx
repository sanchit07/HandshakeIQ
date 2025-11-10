import React, { useState, useMemo, useEffect } from 'react';
import { Person, Meeting, CalendarEvent, CalendarAttendee } from '../types';
import { SearchIcon, CalendarIcon, CameraIcon } from './icons/UIIcons';
import { GoogleIcon, ZohoIcon, MicrosoftIcon } from './icons/BrandIcons';
import { useTodayTomorrowEvents } from '../client/hooks/useCalendar';
import { useAuth } from '../client/hooks/useAuth';

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

const SearchBar: React.FC<{ 
    people: Person[]; 
    onSelectPerson: (person: Person) => void; 
    onOpenScanner: () => void;
    initialSearch: string;
}> = ({ people, onSelectPerson, onOpenScanner, initialSearch }) => {
    const [query, setQuery] = useState('');
    const [isFocused, setIsFocused] = useState(false);

    useEffect(() => {
        if (initialSearch) {
            setQuery(initialSearch);
            setIsFocused(true);
        }
    }, [initialSearch]);

    const filteredPeople = useMemo(() => {
        if (!query) return [];
        const lowerCaseQuery = query.toLowerCase();
        return people.filter(p => 
            p.name.toLowerCase().includes(lowerCaseQuery) || 
            p.company.toLowerCase().includes(lowerCaseQuery) ||
            p.email.toLowerCase().includes(lowerCaseQuery)
        );
    }, [query, people]);

    const handleSelect = (person: Person) => {
        setQuery('');
        onSelectPerson(person);
        setIsFocused(false);
    };

    return (
        <div className="relative w-full max-w-2xl mx-auto animate-slide-up-fade" style={{animationDelay: '100ms'}}>
            <div className="relative">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none">
                    <SearchIcon />
                </div>
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setTimeout(() => setIsFocused(false), 200)}
                    placeholder="Search operative by name, company, or email..."
                    className="w-full pl-12 pr-12 py-3 bg-gray-900/50 border border-cyan-500/30 rounded-full text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-cyan-400 transition-all duration-300 shadow-lg shadow-cyan-500/10"
                />
                <button 
                    onClick={onOpenScanner} 
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-cyan-400 hover:text-white transition-colors p-1 rounded-full hover:bg-cyan-500/20"
                    aria-label="Scan business card"
                >
                    <CameraIcon />
                </button>
            </div>
            {isFocused && query && (
                <div className="z-10 w-full mt-2 bg-gray-900/90 backdrop-blur-md border border-cyan-500/30 rounded-lg shadow-lg shadow-cyan-500/10 max-h-80 overflow-y-auto animate-fade-in">
                    {filteredPeople.length > 0 ? (
                        filteredPeople.map(person => (
                            <div key={person.id} onMouseDown={() => handleSelect(person)} className="flex items-center p-3 hover:bg-cyan-900/50 cursor-pointer transition-colors border-b border-cyan-500/10 last:border-b-0">
                                <img src={person.photoUrl} alt={person.name} className="w-12 h-12 rounded-full mr-4 border-2 border-cyan-600/50" />
                                <div>
                                    <p className="font-bold text-white">{person.name}</p>
                                    <p className="text-sm text-cyan-300">{person.title} at {person.company}</p>
                                </div>
                            </div>
                        ))
                    ) : (
                        <p className="p-4 text-gray-400">No operatives found matching "{query}".</p>
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
  return (
    <div className="mt-8 animate-slide-up-fade" style={{animationDelay: '200ms'}}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="flex items-center text-xl font-exo text-cyan-300">
          <CalendarIcon className="mr-3" />
          Today & Tomorrow
        </h2>
        {events.length > 0 && (
          <button
            onClick={onGoToUpcomingMeetings}
            className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            View All →
          </button>
        )}
      </div>
      
      {events.length === 0 ? (
        <div className="bg-black/20 border border-cyan-500/20 rounded-lg p-6 text-center">
          <p className="text-gray-300">No meetings today or tomorrow</p>
          <button
            onClick={onGoToUpcomingMeetings}
            className="mt-3 text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            View upcoming meetings →
          </button>
        </div>
      ) : (
        <div className="space-y-4 stagger-in">
          {events.map((event, index) => (
            <div 
              key={event.id} 
              className="p-4 bg-gray-900/40 border border-cyan-500/20 rounded-lg backdrop-blur-sm transition-all duration-300 hover:border-cyan-400/50 hover:shadow-cyan-500/10 hover:shadow-lg"
              style={{animationDelay: `${index * 100 + 300}ms`}}
            >
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-white font-exo">{event.summary}</h3>
                  <p className="text-sm text-gray-400">{formatDateTime(event.start)}</p>
                  {event.location && (
                    <p className="text-xs text-cyan-300 mt-1">📍 {event.location}</p>
                  )}
                </div>
                <div className="text-gray-400" title="From Google Calendar">
                  <GoogleIcon />
                </div>
              </div>
              
              {event.attendees.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {event.attendees.slice(0, 4).map((attendee, idx) => (
                    <button
                      key={idx}
                      onClick={() => onSelectAttendee(attendee)}
                      className="flex items-center space-x-2 px-3 py-1 bg-cyan-900/30 hover:bg-cyan-800/50 border border-cyan-600/30 rounded-full transition-all duration-200 hover:scale-105"
                    >
                      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-xs font-semibold">
                        {(attendee.displayName || attendee.email || '?')[0].toUpperCase()}
                      </div>
                      <span className="text-sm text-cyan-200">
                        {attendee.displayName || attendee.email?.split('@')[0]}
                      </span>
                    </button>
                  ))}
                  {event.attendees.length > 4 && (
                    <button
                      onClick={onGoToUpcomingMeetings}
                      className="px-3 py-1 text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
                    >
                      +{event.attendees.length - 4} more
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const MeetingList: React.FC<{ meetings: Meeting[]; onSelectPerson: (person: Person) => void; onGoToSettings: () => void; }> = ({ meetings, onSelectPerson, onGoToSettings }) => {
    const getSourceIcon = (source?: string) => {
        switch(source) {
            case 'google': return <GoogleIcon />;
            case 'zoho': return <ZohoIcon />;
            case 'microsoft': return <MicrosoftIcon />;
            default: return null;
        }
    }
    return (
    <div className="mt-8 animate-slide-up-fade" style={{animationDelay: '200ms'}}>
        <h2 className="flex items-center text-xl font-exo text-cyan-300 mb-4">
            <CalendarIcon className="mr-3" />
            Upcoming Transmissions (Demo Data)
        </h2>
        <div className="space-y-4 stagger-in">
            {meetings.map((meeting, index) => (
                <div 
                    key={meeting.id} 
                    className="p-4 bg-gray-900/40 border border-cyan-500/20 rounded-lg backdrop-blur-sm transition-all duration-300 hover:border-cyan-400/50 hover:shadow-cyan-500/10 hover:shadow-lg"
                    style={{animationDelay: `${index * 100 + 300}ms`}}
                >
                    <div className="flex justify-between items-start">
                        <div>
                            <h3 className="font-bold text-white font-exo">{meeting.title}</h3>
                            <p className="text-sm text-gray-400">{meeting.time}</p>
                        </div>
                         <div className="text-gray-400" title={`From ${meeting.source} calendar`}>
                           {getSourceIcon(meeting.source)}
                        </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                        {meeting.attendees.map(attendee => (
                            <button
                                key={attendee.id}
                                onClick={() => onSelectPerson(attendee)}
                                className="flex items-center space-x-2 px-3 py-1 bg-cyan-900/30 hover:bg-cyan-800/50 border border-cyan-600/30 rounded-full transition-all duration-200 hover:scale-105"
                            >
                                <img src={attendee.photoUrl} alt={attendee.name} className="w-6 h-6 rounded-full" />
                                <span className="text-sm text-cyan-200">{attendee.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            ))}
        </div>
        <div className="text-center mt-6">
            <button onClick={onGoToSettings} className="px-6 py-2 text-sm text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors btn-glow">
                Manage Calendar Sync
            </button>
        </div>
    </div>
)};

const Dashboard: React.FC<DashboardProps> = ({ 
  meetings, 
  people, 
  onSelectPerson, 
  onOpenScanner, 
  onGoToSettings, 
  onGoToUpcomingMeetings,
  onSelectAttendee,
  initialSearch 
}) => {
  const { user } = useAuth();
  const { data: calendarEvents, isLoading } = useTodayTomorrowEvents();

  return (
    <div className="max-w-4xl mx-auto p-2">
      <SearchBar people={people} onSelectPerson={onSelectPerson} onOpenScanner={onOpenScanner} initialSearch={initialSearch} />
      
      {user && !isLoading && calendarEvents && calendarEvents.length > 0 ? (
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