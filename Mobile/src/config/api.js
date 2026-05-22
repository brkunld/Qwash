const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export const getApiUrl = (path = "") => {
  if (!API_BASE_URL) {
    throw new Error("API_BASE_URL_MISSING");
  }

  return `${API_BASE_URL.replace(/\/$/, "")}${path}`;
};