import { useQuery } from "@tanstack/react-query";

export function useAuth() {
  const { data: user, isLoading, error, isSuccess } = useQuery({
    queryKey: ["/api/auth/user"],
    retry: false,
    // Don't throw on error - we need to distinguish between guest mode and actual errors
    throwOnError: false,
  });

  // User is in guest mode ONLY if:
  // 1. Not loading AND
  // 2. Request was successful (no network/server errors) AND
  // 3. User data is explicitly null (server returned null, not 500/network error)
  const isGuest = !isLoading && isSuccess && user === null;
  const isAuthenticated = !isLoading && isSuccess && !!user;

  return {
    user,
    isLoading,
    isAuthenticated,
    isGuest,
    hasError: !isLoading && !isSuccess,
  };
}
