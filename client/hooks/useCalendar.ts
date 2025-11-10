import { useQuery } from "@tanstack/react-query";
import type { CalendarEvent } from "../../types";

export function useTodayTomorrowEvents() {
  return useQuery<CalendarEvent[]>({
    queryKey: ['/api/calendar/today-tomorrow'],
    retry: 1,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useUpcomingEvents(days: number = 30) {
  return useQuery<CalendarEvent[]>({
    queryKey: ['/api/calendar/upcoming', days],
    retry: 1,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
