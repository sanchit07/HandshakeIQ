import React, { useState } from 'react';
import { useUpcomingEvents } from '../client/hooks/useCalendar';
import { BackIcon, CalendarIcon } from './icons/UIIcons';
import type { CalendarEvent, CalendarAttendee } from '../types';

interface UpcomingMeetingsProps {
  onBack: () => void;
  onSelectAttendee: (attendee: CalendarAttendee) => void;
}

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

const MeetingCard: React.FC<{
  event: CalendarEvent;
  onSelectAttendee: (attendee: CalendarAttendee) => void;
}> = ({ event, onSelectAttendee }) => {
  const [showAllAttendees, setShowAllAttendees] = useState(false);
  const attendeesToShow = showAllAttendees ? event.attendees : event.attendees.slice(0, 5);
  const hasMoreAttendees = event.attendees.length > 5;

  return (
    <div className="bg-black/30 border border-cyan-500/20 rounded-lg p-4 hover:border-cyan-400/40 transition-all animate-fade-in">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-white mb-1">{event.summary}</h3>
          <p className="text-sm text-cyan-300 flex items-center gap-2">
            <CalendarIcon />
            {formatDateTime(event.start)}
          </p>
          {event.location && (
            <p className="text-sm text-gray-400 mt-1">📍 {event.location}</p>
          )}
        </div>
      </div>

      {event.attendees.length > 0 && (
        <div className="mt-3 pt-3 border-t border-cyan-500/10">
          <p className="text-xs text-gray-400 mb-2">
            Participants ({event.attendees.length})
          </p>
          <div className="space-y-2">
            {attendeesToShow.map((attendee, index) => (
              <button
                key={index}
                onClick={() => onSelectAttendee(attendee)}
                className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-cyan-900/30 transition-colors group text-left"
              >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white font-semibold text-sm">
                  {(attendee.displayName || attendee.email || '?')[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white group-hover:text-cyan-300 transition-colors truncate">
                    {attendee.displayName || attendee.email}
                  </p>
                  {attendee.email && attendee.displayName && (
                    <p className="text-xs text-gray-400 truncate">{attendee.email}</p>
                  )}
                </div>
                {attendee.organizer && (
                  <span className="text-xs bg-cyan-600/30 text-cyan-300 px-2 py-1 rounded">
                    Organizer
                  </span>
                )}
                {attendee.optional && (
                  <span className="text-xs bg-gray-600/30 text-gray-300 px-2 py-1 rounded">
                    Optional
                  </span>
                )}
              </button>
            ))}
            {hasMoreAttendees && !showAllAttendees && (
              <button
                onClick={() => setShowAllAttendees(true)}
                className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
              >
                +{event.attendees.length - 5} more attendees
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const UpcomingMeetings: React.FC<UpcomingMeetingsProps> = ({ onBack, onSelectAttendee }) => {
  const { data: events, isLoading, error } = useUpcomingEvents(30);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center mb-6 animate-slide-down-fade">
        <button
          onClick={onBack}
          className="mr-4 p-2 hover:bg-cyan-500/20 rounded-full transition-colors group"
          aria-label="Go back"
        >
          <BackIcon />
        </button>
        <div>
          <h1 className="font-exo text-3xl font-bold text-white">Upcoming Meetings</h1>
          <p className="text-cyan-300 text-sm mt-1">Next 30 days from your Google Calendar</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-2">
        {isLoading && (
          <div className="flex items-center justify-center h-64">
            <div className="text-cyan-300">Loading calendar events...</div>
          </div>
        )}

        {error && (
          <div className="bg-red-900/20 border border-red-500/30 rounded-lg p-4 text-center">
            <p className="text-red-400">Failed to load calendar events</p>
            <p className="text-sm text-gray-400 mt-2">
              Make sure you've granted calendar access when signing in with Google
            </p>
          </div>
        )}

        {events && events.length === 0 && (
          <div className="bg-black/20 border border-cyan-500/20 rounded-lg p-8 text-center">
            <CalendarIcon className="mx-auto mb-3 text-cyan-400" />
            <p className="text-gray-300">No upcoming meetings found</p>
            <p className="text-sm text-gray-500 mt-2">Your calendar is clear for the next 30 days</p>
          </div>
        )}

        {events && events.length > 0 && (
          <div className="space-y-4">
            {events.map((event) => (
              <MeetingCard
                key={event.id}
                event={event}
                onSelectAttendee={onSelectAttendee}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default UpcomingMeetings;
