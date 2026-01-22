import { createUser } from "../services/user.service.js";

export async function registerUser(req, res) {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username required" });
  }

  const user = await createUser(username);
  res.json(user);
}
