export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Simpele login URL zonder crash
export const getLoginUrl = () => {
  const baseUrl = import.meta.env.VITE_OAUTH_SERVER_URL;

  return `${baseUrl}/auth/login`;
};
