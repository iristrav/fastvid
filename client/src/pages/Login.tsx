import { useEffect } from "react";
import { useLocation } from "wouter";

export default function Login() {
  const [, navigate] = useLocation();

  useEffect(() => {
    // Simuleer login
    setTimeout(() => {
      // zet fake login status (tijdelijk)
      localStorage.setItem("loggedIn", "true");

      navigate("/dashboard");
    }, 1000);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center text-white">
      <h1>Inloggen...</h1>
    </div>
  );
}
