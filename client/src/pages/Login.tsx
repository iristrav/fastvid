import { useEffect } from "react";
import { useLocation } from "wouter";

export default function Login() {
  const [location] = useLocation();

  useEffect(() => {
    // pak query params uit URL
    const params = new URLSearchParams(location.split("?")[1]);
    const prompt = params.get("prompt") || "";
    const length = params.get("length") || "15-20";

    // simuleer login
    setTimeout(() => {
      window.location.href = `/dashboard?prompt=${encodeURIComponent(prompt)}&length=${length}`;
    }, 1000);
  }, [location]);

  return (
    <div className="min-h-screen flex items-center justify-center text-white">
      <h1>Inloggen...</h1>
    </div>
  );
}
