import { loginOrCreate } from "../services/auth.service.js";

export async function login(req, res) {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username required" });
  }

  try {
    const user = await loginOrCreate(username);
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
