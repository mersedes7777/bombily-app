import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import authRoutes from "./routes/auth.js";
import ridesRoutes from "./routes/rides.js";
import usersRoutes from "./routes/users.js";
import reportsRoutes from "./routes/reports.js";
import notifyRoutes from "./routes/notify.js";
import { startCronJobs } from "./cron/index.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => res.json({ ok: true, service: "pulse-backend" }));

app.use("/auth", authRoutes);
app.use("/rides", ridesRoutes);
app.use("/users", usersRoutes);
app.use("/reports", reportsRoutes);
app.use("/notify", notifyRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pulse backend running on port ${PORT}`);
  startCronJobs();
});
