// app/page.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Page() {
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const login = async () => {
    if (!username.trim()) return;
    
    setLoading(true);
    try {
      const res = await fetch("http://localhost:4000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });

      const user = await res.json();
      localStorage.setItem("user", JSON.stringify(user));
      router.push("/chat");
    } catch (error) {
      console.error("Login failed:", error);
      alert("Login failed. Check console.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <h1>Login to Chat</h1>
      <input
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        onKeyPress={(e) => e.key === "Enter" && login()}
        placeholder="Enter username"
        style={{ padding: "0.5rem", marginRight: "0.5rem" }}
      />
      <button
        onClick={login}
        disabled={loading}
        style={{ padding: "0.5rem 1rem", cursor: loading ? "not-allowed" : "pointer" }}
      >
        {loading ? "Logging in..." : "Enter"}
      </button>
    </div>
  );
}
