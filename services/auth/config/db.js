import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

pool.on("error", (err) => {
    console.error("Unexpected PostgreSQL pool error:", err);
});

export const connectDB = async () => {
    await pool.query("SELECT 1");
    console.log("PostgreSQL connected successfully");
};

export default pool;
