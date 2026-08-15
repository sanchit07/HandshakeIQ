import { useQuery } from "@tanstack/react-query";

export function useAuth() {
  const { data: user, isLoading, error, isSuccess } = useQuery({
    queryKey: ["/api/auth/user"],
    // Retry network failures (no HTTP status) up to 3 times with exponential backoff
    // React Query wraps fetch errors as generic Error objects, so we check for:
    // - TypeError (network failures like ECONNREFUSED)
    // - No status field (indicates network error vs HTTP error)
    retry: (failureCount, error: any) => {
      // Retry on network failures (no HTTP status returned)
      // This includes ECONNREFUSED, DNS failures, etc.
      if (!error?.status && failureCount < 3) {
        return true;
      }
      return false;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 3000),
    // Don't throw on error - we need to distinguish between guest mode and actual errors
    throwOnError: false,
  });

  // User is in guest mode ONLY if:
  // 1. Not loading AND
  // 2. Request was successful (no network/server errors) AND
  // 3. User data is explicitly null (server returned null, not 500/network error)
  const isGuest = !isLoading && isSuccess && user === null;
  const isAuthenticated = !isLoading && isSuccess && !!user;
  const isAdmin = isAuthenticated && !!(user as any)?.isAdmin;
  
  // Only show error if not loading, not successful, AND it has an HTTP status
  // (meaning it's a real HTTP error, not a network failure we're retrying)
  const hasError = !isLoading && !isSuccess && !!error?.status;

  return {
    user,
    isLoading,
    isAuthenticated,
    isAdmin,
    isGuest,
    hasError,
  };
}
