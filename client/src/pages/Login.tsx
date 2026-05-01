import { useEffect } from "react";

export default function Login() {
  useEffect(() => {
    // Simuleer login (later vervang je dit met echte auth)
    setTimeout(() => {
      window.location.href = "/dashboard";
    }, 1000);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center text-white">
      <h1>Inloggen...</h1>
    </div>
  );
}
