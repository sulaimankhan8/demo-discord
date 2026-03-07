"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function Dashboard() {
  const router = useRouter();

  useEffect(() => {
    const user = localStorage.getItem("user");
    if (!user) {
      router.push("/");
    }
  }, []);

  return (
    <div className="h-screen bg-gray-900 text-white flex flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-bold">Welcome</h1>

      <div className="flex gap-6">
        <Link
          href="/chat"
          className="px-6 py-4 bg-indigo-600 rounded-lg hover:bg-indigo-700 transition"
        >
          Enter Text Chat
        </Link>

        <Link
          href="/voice"
          className="px-6 py-4 bg-green-600 rounded-lg hover:bg-green-700 transition"
        >
          Join Voice Channel
        </Link>
      </div>
    </div>
  );
}