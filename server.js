require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
// 1. Import the tools we installed
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const axios = require("axios");
const fs = require('fs'); const path = require('path');
const cron = require('node-cron');
// Set up Multer to store the uploaded file temporarily in the server's memory
const upload = multer({ storage: multer.memoryStorage() });

// 2. Initialize the Express application
const app = express();

// 3. Set up Middleware
app.use(cors()); // Allows your frontend to communicate with this backend
app.use(express.json()); // Allows the server to understand JSON data

// Admin Security Middleware
const verifyAdmin = (req, res, next) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey === process.env.ADMIN_SECRET_KEY) {
        next(); // Key matches, let them through!
    } else {
        res.status(403).json({ error: "Unauthorized: Admin access required." });
    }
};

// Use the cloud database URL (we will give this to Render later)
const db = mysql.createPool(process.env.DATABASE_URL);

// Test the database connection
db.getConnection((err, connection) => {
    if (err) {
        console.error('Error connecting to MySQL:', err.message);
    } else {
        console.log('Successfully connected to the LIVE Cloud Database!');
        connection.release();
    }
});

// Test the database connection
db.getConnection((err, connection) => {
    if (err) {
        console.error('Error connecting to MySQL:', err.message);
    } else {
        console.log('Successfully connected to the MySQL Database!');
        connection.release();
    }
});

// 5. Create a simple test route
app.get('/api/test', (req, res) => {
    res.json({ message: 'Hello from the Success Academy Backend!' });
});

// 6. Start the server
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

const nodemailer = require('nodemailer');

// Temporary in-memory storage for OTPs (In production, use Redis or a database table)
const otpStore = new Map();

// Setup Nodemailer Transporter (Replace with your actual Gmail and App Password)
// Note: You must enable "App Passwords" in your Google Account security settings.
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // Use SSL
    auth: {
        user: 'kp30023002@gmail.com',
        pass: process.env.EMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false // Helps bypass strict local network firewalls
    }
});

// --- NEW ROUTE: Send OTP ---
app.post('/api/send-otp', async (req, res) => {
    const { email, name } = req.body;
    
    // Generate a random 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    
    // Store OTP with a 5-minute expiration
    otpStore.set(email, { otp: otp, expires: Date.now() + 300000 });

    try {
        await transporter.sendMail({
            from: 'kp30023002@gmail.com',
            to: email,
            subject: 'Success Academy - Registration OTP',
            text: `Hello ${name},\n\nYour OTP for Success Academy registration is: ${otp}\nThis OTP is valid for 5 minutes.`
        });
        res.json({ success: true, message: 'OTP sent successfully!' });
    } catch (error) {
        console.error('Email Error:', error);
        res.status(500).json({ error: 'Failed to send OTP email.' });
    }
});

// ==========================================
// 1. STUDENT REGISTRATION API (UPDATED WITH NEW FIELDS)
// ==========================================
app.post('/api/register', (req, res) => {
    // 1. Extract the new fields along with the old ones
    const { name, phone, email, parentPhone, schoolName, standard, studentType, subjectGroup, targetExam, otp } = req.body;

    // 2. Verify OTP
    const storedOtpData = otpStore.get(email);
    if (!storedOtpData) {
        return res.status(400).json({ error: 'OTP expired or not requested.' });
    }
    if (storedOtpData.otp !== otp) {
        return res.status(400).json({ error: 'Invalid OTP. Please try again.' });
    }
    if (Date.now() > storedOtpData.expires) {
        otpStore.delete(email);
        return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    // 3. Insert into MySQL database including parent_phone and school_name
    const query = `INSERT INTO users (name, phone, email, parent_phone, school_name, standard, student_type, subject_group, target_exam, is_approved) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, false)`;
    
    db.query(query, [name, phone, email, parentPhone, schoolName, standard, studentType, subjectGroup, targetExam], (err, result) => {
        if (err) {
            console.error('Registration Error:', err);
            return res.status(500).json({ error: 'Database error during registration' });
        }
        
        // Clear the OTP from memory so it can't be reused
        otpStore.delete(email);
        res.json({ success: true, message: 'Application submitted successfully! Waiting for admin approval.' });
    });
});

// ==========================================
// 2. LOGIN API (Admin & Student)
// ==========================================
// This replaces your hardcoded "1234" logic in Main.js
app.post('/api/login', (req, res) => {
    const { reg_no, password } = req.body;

    // Ask MySQL: Does this user exist with this exact password?
    const query = `SELECT * FROM users WHERE reg_no = ? AND password = ? AND is_approved = true`;

    db.query(query, [reg_no, password], (err, results) => {
        if (err) {
            console.error('Login Error:', err);
            return res.status(500).json({ error: 'Database error during login' });
        }

        // If results array has something, the user exists!
        // If results array has something, the user exists!
        if (results.length > 0) {
            const user = results[0];

            // NEW: Check if the student has graduated
            if (user.status === 'Graduated') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Thank you for choosing Success and trusting us to shape your future. Have a great journey in life ahead!' 
                });
            }

            res.json({ 
                success: true,
                message: 'Login successful', 
                user: {
                    id: user.id,
                    reg_no: user.reg_no,
                    name: user.name,
                    role: user.role,
                    standard: user.standard,
                    student_type: user.student_type,
                    subject_group: user.subject_group
                }
            });
        } else {
            // User not found or incorrect password
            res.status(401).json({ success: false, error: 'Invalid Registration Number or Password, or account not approved yet.' });
        }
    });
});
// ==========================================
// 3. ADMIN: GET PENDING STUDENTS
// ==========================================
// Fetches all students waiting for approval
app.get('/api/admin/pending-students',verifyAdmin, (req, res) => {
    const query = `SELECT id, name, standard, student_type, subject_group, phone FROM users WHERE is_approved = false AND role = 'student'`;
    
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching pending students:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});

// ==========================================
// 4. ADMIN: APPROVE STUDENT & AUTO-GENERATE ID (YOUR EXACT FORMAT)
// ==========================================
app.post('/api/admin/approve-student',verifyAdmin, async (req, res) => {
    const { student_id } = req.body;

    try {
        const [students] = await db.promise().query(`SELECT * FROM users WHERE id = ?`, [student_id]);
        if (students.length === 0) return res.status(404).json({ error: 'Student not found' });
        
        const student = students[0];

        // --- START OF YOUR CUSTOM ID LOGIC (UNIVERSITY MODEL) ---
        // 1. Get the full 4-digit year (e.g., '2026')
        const year = new Date().getFullYear().toString(); 
        
        // 2. Get Serial Number (Count of already approved students + 1)
        // Note: Even if you archive/graduate students later, this count ensures the serial never overlaps.
        const [countResult] = await db.promise().query(`SELECT COUNT(*) as count FROM users WHERE is_approved = true`);
        const serialNo = String(countResult[0].count + 1).padStart(3, '0'); // Turns 1 into '001'

        // 3. Combine into the final Registration Number
        // Example Output: SA2026001
        const reg_no = `SA${year}${serialNo}`;
        
        // 4. Password is exactly the last 4 digits of the generated ID (e.g., "6001")
        const password = reg_no.slice(-4);
        // --- END OF YOUR CUSTOM ID LOGIC ---

        // Update the database with the new credentials
        await db.promise().query(
            `UPDATE users SET reg_no = ?, password = ?, is_approved = true WHERE id = ?`,
            [reg_no, password, student_id]
        );

        // Send the welcome email (since we dropped SMS)
        await transporter.sendMail({
            from: '"Success Academy" <kp30023002@gmail.com>',
            to: student.email,
            subject: 'Admission Approved! Your Login Credentials',
            text: `Dear ${student.name},\n\nCongratulations! Your admission to Success Academy has been approved.\n\nHere are your official student portal login details:\n\nRegistration Number (User ID): ${reg_no}\nPassword: ${password}\n\nPlease keep these safe.\n\nBest Regards,\nSuccess Academy Team`
        });

        res.json({ success: true, message: 'Student Approved!', credentials: { reg_no, password } });

    } catch (error) {
        console.error('Approval Error:', error);
        res.status(500).json({ error: 'Database or Email error during approval.' });
    }
});
// ==========================================
// 5. ADMIN: REJECT STUDENT
// ==========================================
app.post('/api/admin/reject-student',verifyAdmin, (req, res) => {
    const { student_id } = req.body;

    // Delete the student from the database entirely
    const query = `DELETE FROM users WHERE id = ? AND is_approved = false`;
    
    db.query(query, [student_id], (err, result) => {
        if (err) {
            console.error('Error rejecting student:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true, message: 'Student application rejected and removed.' });
    });
});
// ==========================================
// 6. ADMIN: UPLOAD EXCEL MARKS (Bulletproof Version)
// ==========================================
app.post('/api/admin/upload-marks', verifyAdmin, upload.single('marksFile'), async (req, res) => {
    console.log("1. Upload request received!"); // <-- This will print in your terminal

    if (!req.file) {
        console.log("❌ Error: No file found.");
        return res.status(400).json({ error: 'No Excel file uploaded' });
    }

    const { standard, examTitle, examDate, subject } = req.body;
    console.log(`2. Form data received: ${standard}, ${subject}, ${examTitle}`);

    try {
        // Read the file
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0]; 
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet);

        console.log(`3. Excel parsed successfully. Found ${rows.length} rows.`);

        if (rows.length === 0) {
            return res.status(400).json({ error: 'The Excel sheet is empty' });
        }

        let processedCount = 0;

        // Loop through each row
        for (let row of rows) {
            const regNo = row['Registration Number'];
            const marksObtained = row['Marks Obtained'];
            const totalMarks = row['Total Marks'];

            if (!regNo) {
                console.log("⚠️ Skipped a row because Registration Number was blank.");
                continue; 
            }

            console.log(`4. Looking for student: ${regNo}`);

            // Find student in MySQL
            const [users] = await db.promise().query(`SELECT id FROM users WHERE reg_no = ? AND standard = ?`, [regNo, standard]);
            
            if (users.length > 0) {
                const studentId = users[0].id;
                
                // Insert Marks
                await db.promise().query(
                    `INSERT INTO marks (student_id, standard, exam_title, exam_date, subject, marks_obtained, total_marks) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [studentId, standard, examTitle, examDate, subject, marksObtained, totalMarks]
                );

                // Insert Notice
                const noticeTitle = `New Marks Uploaded: ${subject}`;
                const noticeMessage = `You scored ${marksObtained} out of ${totalMarks} in ${examTitle} on ${examDate}.`;
                await db.promise().query(
                    `INSERT INTO personal_notices (student_id, title, message, notice_type) VALUES (?, ?, ?, 'Marks')`,
                    [studentId, noticeTitle, noticeMessage]
                );

                processedCount++;
                console.log(`✅ Marks saved for ${regNo}`);
            } else {
                console.log(`❌ Could not find active student with Reg No: ${regNo} in ${standard}`);
            }
        }

        console.log("5. Upload process completely finished!");
        res.json({ success: true, message: `Successfully processed ${processedCount} records for ${subject}!` });

    } catch (error) {
        console.error('❌ Server Crash Error:', error);
        res.status(500).json({ error: 'Failed to process the Excel file' });
    }
});
// ==========================================
// 7. STUDENT: GET DASHBOARD DATA (UPDATED WITH ATTENDANCE)
// ==========================================
app.get('/api/student/dashboard/:id', async (req, res) => {
    const studentId = req.params.id;

    try {
        // 1. Get Student Profile
        const [users] = await db.promise().query(
            `SELECT id, name, reg_no, standard, student_type, subject_group, target_exam FROM users WHERE id = ?`, 
            [studentId]
        );

        if (users.length === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }

// 2. Calculate Attendance Percentage Safely
        const [attendanceData] = await db.promise().query(`
            SELECT 
                COUNT(*) as total_days, 
                SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) as present_days 
            FROM attendance 
            WHERE student_id = ?
        `, [studentId]);

        let attendancePercentage = 0; // Starts at 0% for brand new students!
        
        const totalDays = parseInt(attendanceData[0].total_days) || 0;
        const presentDays = parseInt(attendanceData[0].present_days) || 0;

        // Only calculate if the admin has marked attendance at least once
        if (totalDays > 0) {
            attendancePercentage = Math.round((presentDays / totalDays) * 100);
        }
        
        // Attach attendance to the profile object
        const profileData = users[0];
        profileData.attendance_percentage = attendancePercentage;

        // 3. Get Personal Notices
        const [notices] = await db.promise().query(
            `SELECT title, message, notice_type, date_posted FROM personal_notices WHERE student_id = ? ORDER BY date_posted DESC`,
            [studentId]
        );

        // 4. Get Recent Marks
        const [marks] = await db.promise().query(
            `SELECT exam_title, subject, marks_obtained, total_marks, exam_date FROM marks WHERE student_id = ? ORDER BY exam_date DESC`,
            [studentId]
        );

        res.json({
            success: true,
            profile: profileData,
            notices: notices,
            marks: marks
        });

    } catch (error) {
        console.error('Dashboard Error:', error);
        res.status(500).json({ error: 'Server error loading dashboard' });
    }
});
// ==========================================
// 8. GLOBAL EVENTS APIs
// ==========================================

// ADMIN: Add a new event
app.post('/api/admin/events', verifyAdmin, (req, res) => {
    const { title, description, target_standard, target_type, event_date } = req.body;
    const query = `INSERT INTO global_events (title, description, target_standard, target_type, event_date) VALUES (?, ?, ?, ?, ?)`;
    
    db.query(query, [title, description, target_standard, target_type, event_date], (err, result) => {
        if (err) {
            console.error('Error adding event:', err);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true, message: 'Event added successfully' });
    });
});

// STUDENT: Fetch filtered events
app.get('/api/student/events', (req, res) => {
    const { standard, type } = req.query;
    
    // Fetch events that target 'Both' standards or the specific standard,
    // AND target 'All' types or the specific batch type.
    const query = `
        SELECT * FROM global_events 
        WHERE (target_standard = 'Both' OR target_standard = ?) 
        AND (target_type = 'All' OR target_type = ?)
        ORDER BY event_date ASC
    `;
    
    db.query(query, [standard, type], (err, results) => {
        if (err) {
            console.error('Error fetching events:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});

// ==========================================
// 9. MESSAGING APIs (Using your student_queries table)
// ==========================================

// STUDENT: Send a message to Admin
app.post('/api/student/messages', (req, res) => {
    const { student_id, query_text } = req.body;
    
    // We manually add NOW() for created_at so the database never rejects it
    const query = `INSERT INTO student_queries (student_id, query_text, status, created_at) VALUES (?, ?, 'Pending', NOW())`;
    
    db.query(query, [student_id, query_text], (err, result) => {
        if (err) {
            console.error('Error sending message:', err);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true });
    });
});

// STUDENT: Get all messages for their dashboard
app.get('/api/student/messages/:id', (req, res) => {
    const studentId = req.params.id;
    const query = `SELECT * FROM student_queries WHERE student_id = ? ORDER BY created_at DESC`;
    
    db.query(query, [studentId], (err, results) => {
        if (err) {
            console.error('Error fetching student messages:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});

// ADMIN: Get all messages from all students
app.get('/api/admin/messages', verifyAdmin, (req, res) => {
    // We use a JOIN here to grab the student's real name and batch details from the users table!
    const query = `
        SELECT sq.*, u.name, u.reg_no, u.standard, u.student_type 
        FROM student_queries sq
        JOIN users u ON sq.student_id = u.id
        ORDER BY CASE WHEN sq.status = 'Pending' THEN 1 ELSE 2 END, sq.created_at DESC
    `;
    
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching admin messages:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});

// ADMIN: Reply to a message
// ADMIN: Reply to a message
app.post('/api/admin/messages/reply', verifyAdmin, (req, res) => {
    const { query_id, admin_reply } = req.body; // or `id` depending on which version you used
    
    // FIX: Changed 'Resolved' to 'Replied' to match your SQL database
    const query = `UPDATE student_queries SET admin_reply = ?, status = 'Replied' WHERE id = ?`;
    
    db.query(query, [admin_reply, query_id], (err, result) => {
        if (err) {
            console.error('Error replying to message:', err);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true });
    });
});
// ==========================================
// 10. ATTENDANCE APIs
// ==========================================

app.get('/api/admin/students-by-batch', verifyAdmin, (req, res) => {
    const { date, standard, type } = req.query;
    
    if (!date) return res.status(400).json({ error: 'Date is required to filter attendance.' });

    let query;
    let params;

    // Added two crucial filters:
    // 1. (status = 'Active' OR status IS NULL) -> Removes Graduated students
    // 2. id NOT IN (...) -> Removes students who already have attendance marked for the given date

    if (type === 'All') {
        query = `
            SELECT id, name, reg_no, student_type 
            FROM users 
            WHERE standard = ? 
              AND is_approved = true 
              AND role = 'student'
              AND (status = 'Active' OR status IS NULL)
              AND id NOT IN (SELECT student_id FROM attendance WHERE date = ?)
            ORDER BY reg_no ASC
        `;
        params = [standard, date];
    } else {
        query = `
            SELECT id, name, reg_no, student_type 
            FROM users 
            WHERE standard = ? 
              AND student_type = ? 
              AND is_approved = true 
              AND role = 'student'
              AND (status = 'Active' OR status IS NULL)
              AND id NOT IN (SELECT student_id FROM attendance WHERE date = ?)
            ORDER BY reg_no ASC
        `;
        params = [standard, type, date];
    }

    db.query(query, params, (err, results) => {
        if (err) {
            console.error('Error fetching students for attendance:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});

// ADMIN: Submit bulk attendance to the database
app.post('/api/admin/attendance', verifyAdmin, async (req, res) => {
    const { date, attendanceData } = req.body;
    // attendanceData is an array like: [{ student_id: 1, status: 'Present' }, { student_id: 2, status: 'Absent' }]

    if (!attendanceData || attendanceData.length === 0) {
        return res.status(400).json({ error: 'No attendance data provided.' });
    }

    try {
        // Convert the array of objects into a 2D array for bulk insertion in MySQL
        const values = attendanceData.map(record => [record.student_id, date, record.status]);
        
        // MySQL bulk insert command
        const query = `INSERT INTO attendance (student_id, date, status) VALUES ?`;
        
        await db.promise().query(query, [values]);

        res.json({ success: true, message: 'Attendance saved successfully.' });
    } catch (error) {
        console.error('Error submitting attendance:', error);
        
        // Error code ER_DUP_ENTRY usually means the unique index triggered (attendance already taken today)
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Attendance for one or more students has already been marked for this date.' });
        }
        
        res.status(500).json({ error: 'Database error while submitting attendance.' });
    }
});
// ==========================================
// ADMIN: PUBLISH NOTICE
// ==========================================
app.post('/api/admin/publish-notice', verifyAdmin, async (req, res) => {
    const { noticeType, targetRegNo, title, content } = req.body;

    try {
        if (targetRegNo) {
            // Send to specific student
            const [users] = await db.promise().query(
                `SELECT id FROM users WHERE reg_no = ?`,
                [targetRegNo]
            );

            if (users.length === 0) {
                return res.status(404).json({ error: "Student not found" });
            }

            await db.promise().query(
                `INSERT INTO personal_notices (student_id, title, message, notice_type) VALUES (?, ?, ?, ?)`,
                [users[0].id, title, content, noticeType]
            );
        } else {
            // Send to all students
            const [students] = await db.promise().query(
                `SELECT id FROM users WHERE role='student'`
            );

            for (let student of students) {
                await db.promise().query(
                    `INSERT INTO personal_notices (student_id, title, message, notice_type) VALUES (?, ?, ?, ?)`,
                    [student.id, title, content, noticeType]
                );
            }
        }

        res.json({ success: true, message: "Notice Published Successfully" });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ==========================================
// AI DOUBT SOLVER - SMART GEMINI VERSION
// ==========================================

app.post('/api/ai-doubt', async (req, res) => {
    const { query } = req.body;

    if (!query) {
        return res.status(400).json({ error: "No query provided" });
    }

    try {

        // ===============================
        // STEP 1: Ask Gemini to classify
        // ===============================
        const classificationResponse = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSyDFPcvxFxdcEpdxZ4q_-Rlb8nQ3cgeU-3k`,
            {
                contents: [{
                    parts: [{
                        text: `
You are an academic content classifier.

Tell me whether the following question is related to:
- School studies
- Competitive exams (JEE, NEET, MHT-CET)
- Academic subjects like Physics, Chemistry, Math, Biology

Reply ONLY with one word:
YES
or
NO

Question:
${query}
`
                    }]
                }]
            }
        );

        const classificationText =
            classificationResponse.data.candidates[0].content.parts[0].text.trim().toUpperCase();

        // ===============================
        // STEP 2: If NOT academic
        // ===============================
        if (classificationText !== "YES") {
            return res.json({
                success: false,
                message: "Abyas kara Falthu Dhande Nako 😎"
            });
        }

        // ===============================
        // STEP 3: If academic → Generate answer
        // ===============================
        const answerResponse = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSyDFPcvxFxdcEpdxZ4q_-Rlb8nQ3cgeU-3k`,
            {
                contents: [{
                    parts: [{
                        text: `
You are an expert academic assistant for JEE, NEET and MHT-CET students.

Explain the answer in:
- Simple
- Clear
- Exam-friendly language
- No LaTeX symbols
- No $ symbols
- No complex formatting
- Write formulas in plain text

Question:
${query}
`
                    }]
                }]
            }
        );

        const cleanAnswer =
            answerResponse.data.candidates[0].content.parts[0].text;

        res.json({
            success: true,
            answer: cleanAnswer
        });

    } catch (error) {
        console.error("Gemini API Error:", error.response?.data || error.message);
        res.status(500).json({
            error: "AI failed to process your doubt."
        });
    }
});

// ==========================================
// ADMIN: GET DASHBOARD STATS
// ==========================================
app.get('/api/admin/dashboard-stats', verifyAdmin, async (req, res) => {
    try {
        const [totalStudents] = await db.promise().query(
            `SELECT COUNT(*) as count FROM users WHERE is_approved = true AND role = 'student'`
        );

        const [pendingStudents] = await db.promise().query(
            `SELECT COUNT(*) as count FROM users WHERE is_approved = false AND role = 'student'`
        );

        res.json({
            total: totalStudents[0].count,
            pending: pendingStudents[0].count
        });

    } catch (error) {
        console.error("Dashboard Stats Error:", error);
        res.status(500).json({ error: "Failed to fetch dashboard stats" });
    }
});

// ==========================================
// ADMIN: Get Single Student by ID
// ==========================================
app.get('/api/admin/students/:id', verifyAdmin, (req, res) => {
    const studentId = req.params.id;

    // FIX: Added 'email' to the SELECT query
    const query = `
        SELECT id, name, email, reg_no, standard, student_type, subject_group,
               target_exam, phone, parent_phone, school_name
        FROM users
        WHERE id = ?
    `;

    db.query(query, [studentId], (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        if (results.length === 0) return res.status(404).json({ error: "Student not found" });
        res.json(results[0]);
    });
});
// ==========================================
// ADMIN: UPDATE STUDENT
// ==========================================
app.put('/api/admin/students/:id', verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const {
        name, email, phone, parent_phone, // FIX: Added email here
        school_name, standard,
        student_type, subject_group,
        target_exam
    } = req.body;

    try {
        // FIX: Added 'email = ?' to the SET clause
        await db.promise().query(`
            UPDATE users
            SET name = ?, email = ?, phone = ?, parent_phone = ?,
                school_name = ?, standard = ?,
                student_type = ?, subject_group = ?,
                target_exam = ?
            WHERE id = ?
        `, [name, email, phone, parent_phone,
            school_name, standard,
            student_type, subject_group,
            target_exam, id]);

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Update failed" });
    }
});

// ==========================================
// ADMIN: DELETE STUDENT
// ==========================================
app.delete('/api/admin/students/:id', verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const connection = await db.promise().getConnection();

    try {
        await connection.beginTransaction();

        // Delete child tables FIRST
        await connection.query(`DELETE FROM attendance WHERE student_id = ?`, [id]);
        await connection.query(`DELETE FROM marks WHERE student_id = ?`, [id]);
        await connection.query(`DELETE FROM personal_notices WHERE student_id = ?`, [id]);
        await connection.query(`DELETE FROM student_queries WHERE student_id = ?`, [id]);

        // Then delete user
        await connection.query(`DELETE FROM users WHERE id = ?`, [id]);

        await connection.commit();
        connection.release();

        res.json({ success: true });

    } catch (error) {
        await connection.rollback();
        connection.release();
        console.error(error);
        res.status(500).json({ error: "Permanent delete failed" });
    }
});

// ==========================================
// ADMIN: GET ALL APPROVED STUDENTS
// ==========================================
app.get('/api/admin/students', verifyAdmin, async (req, res) => {
    try {
        // FIX: Added 'status' to the SELECT query
        const [students] = await db.promise().query(`
            SELECT id, name, email, reg_no, phone, parent_phone, school_name,
                   standard, student_type, subject_group, target_exam,
                   is_approved, status
            FROM users
            WHERE role = 'student' AND is_approved = true
        `);

        res.json(students);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database error" });
    }
});
// ==========================================
// PUBLIC: HOMEPAGE CONTACT FORM
// ==========================================
app.post('/api/contact', (req, res) => {
    const { name, email, phone, subject, message } = req.body;
    
    const query = `INSERT INTO public_inquiries (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)`;
    
    db.query(query, [name, email, phone, subject, message], (err, result) => {
        if (err) {
            console.error('Contact Form Error:', err);
            return res.status(500).json({ success: false, error: 'Failed to save inquiry.' });
        }
        res.json({ success: true, message: 'Message received successfully!' });
    });
});
// ==========================================
// ADMIN: PUBLIC INQUIRIES LOGIC
// ==========================================

// 1. Fetch all public inquiries
app.get('/api/admin/public-inquiries', verifyAdmin, (req, res) => {
    const query = `SELECT * FROM public_inquiries ORDER BY CASE WHEN status = 'New' THEN 1 ELSE 2 END, created_at DESC`;
    
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results);
    });
});

// 2. Reply to public inquiry (Sends an Email)
app.post('/api/admin/public-inquiries/reply', verifyAdmin, async (req, res) => {
    const { id, email, name, admin_reply } = req.body;

    try {
        // Send actual email to the visitor
        await transporter.sendMail({
            from: '"Success Academy" <kp30023002@gmail.com>',
            to: email,
            subject: 'Reply to your inquiry - Success Academy',
            text: `Dear ${name},\n\nThank you for reaching out to Success Academy.\n\n${admin_reply}\n\nBest Regards,\nSuccess Academy Administration`
        });

        // Update database status to Replied
        db.query(`UPDATE public_inquiries SET status = 'Replied' WHERE id = ?`, [id], (err) => {
            if (err) return res.status(500).json({ success: false, error: 'Failed to update database.' });
            res.json({ success: true, message: 'Email sent successfully!' });
        });
    } catch (error) {
        console.error('Email sending error:', error);
        res.status(500).json({ success: false, error: 'Failed to send email. Check Nodemailer config.' });
    }
});
// ==========================================
// ADMIN: BULK PROMOTE / GRADUATE STUDENTS
// ==========================================
app.post('/api/admin/bulk-promote', verifyAdmin, async (req, res) => {
    const { standard } = req.body;

    try {
        if (standard === '11th') {
            // Promote all active 11th graders to 12th
            const [result] = await db.promise().query(
                `UPDATE users SET standard = '12th' WHERE standard = '11th' AND role = 'student' AND is_approved = true AND (status = 'Active' OR status IS NULL)`
            );
            res.json({ success: true, message: `Successfully promoted ${result.affectedRows} students from 11th to 12th Standard.` });
        
        } else if (standard === '12th') {
            // Change status of all 12th graders to Graduated
            const [result] = await db.promise().query(
                `UPDATE users SET status = 'Graduated' WHERE standard = '12th' AND role = 'student' AND is_approved = true AND (status = 'Active' OR status IS NULL)`
            );
            res.json({ success: true, message: `Successfully graduated ${result.affectedRows} students and revoked their portal access.` });
        
        } else {
            res.status(400).json({ error: 'Invalid standard selected.' });
        }
    } catch (error) {
        console.error("Bulk Promote Error:", error);
        res.status(500).json({ error: 'Database error during bulk action.' });
    }
});

// ==========================================
// ADMISSION INQUIRIES (APPLY FOR ADMISSION)
// ==========================================

// 1. PUBLIC: Submit an application from Homepage
app.post('/api/apply-admission', (req, res) => {
    const { name, phone, email, parentPhone, schoolName, standard, subjectGroup, studentType, targetExam } = req.body;
    
    const query = `INSERT INTO admission_inquiries (name, phone, email, parent_phone, school_name, standard, subject_group, student_type, target_exam) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.query(query, [name, phone, email, parentPhone, schoolName, standard, subjectGroup, studentType, targetExam], (err, result) => {
        if (err) {
            console.error('Admission Apply Error:', err);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true, message: 'Application submitted!' });
    });
});

// 2. ADMIN: Fetch all admission applications
app.get('/api/admin/admission-applications', verifyAdmin, (req, res) => {
    const query = `SELECT * FROM admission_inquiries ORDER BY created_at DESC`;
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results);
    });
});

// 3. ADMIN: Delete (Enquire Done)
app.delete('/api/admin/admission-applications/:id', verifyAdmin, (req, res) => {
    const id = req.params.id;
    db.query(`DELETE FROM admission_inquiries WHERE id = ?`, [id], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: 'Database error' });
        res.json({ success: true });
    });
});

// ==========================================
// DAILY CHALLENGE / WEEKLY LEADERBOARD
// ==========================================

// 1. Submit Exam Score (From DC.js)
app.post('/api/submit-dc-score', (req, res) => {
    const { user_id, exam_type, score } = req.body;
    
    // ON DUPLICATE KEY UPDATE ensures old weekly scores are overwritten by the new week's score
    const query = `
        INSERT INTO dc_scores (user_id, exam_type, score) 
        VALUES (?, ?, ?) 
        ON DUPLICATE KEY UPDATE exam_type = ?, score = ?
    `;
    
    db.query(query, [user_id, exam_type, score, exam_type, score], (err, result) => {
        if (err) {
            console.error('Score Submission Error:', err);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true, message: 'Score saved to Leaderboard!' });
    });
});

// 2. Fetch Leaderboard (For Admin & Student Pages)
app.get('/api/leaderboard', (req, res) => {
    const { exam } = req.query;
    let query = `
        SELECT u.reg_no, u.name, d.score, d.exam_type 
        FROM dc_scores d 
        JOIN users u ON d.user_id = u.id
    `;
    let params = [];

    if (exam && exam !== 'All') {
        query += ` WHERE d.exam_type = ?`;
        params.push(exam);
    }

    query += ` ORDER BY d.score DESC`;

    db.query(query, params, (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results);
    });
});

// ==========================================
// SECURE PDF STREAMING ROUTE
// ==========================================
app.post('/api/secure-view-note', async (req, res) => {
    const { material_id, student_id } = req.body;

    // Basic security check
    if (!student_id || !material_id) {
        return res.status(403).json({ error: "Unauthorized access" });
    }

    try {
        // 1. Find the file path in the database
        const [materials] = await db.promise().query(
            `SELECT file_path FROM study_materials WHERE id = ?`, 
            [material_id]
        );

        if (materials.length === 0) {
            return res.status(404).json({ error: 'Document not found in database.' });
        }

        // 2. Resolve the absolute path to the hidden folder
        const filePath = path.join(__dirname, materials[0].file_path);

        // 3. Check if the physical file exists
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File missing on server.' });
        }

        // 4. Send the file as a raw binary stream
        const stat = fs.statSync(filePath);
        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': stat.size
        });

        const readStream = fs.createReadStream(filePath);
        readStream.pipe(res);

    } catch (error) {
        console.error('Secure PDF Error:', error);
        res.status(500).json({ error: 'Server error while fetching document.' });
    }
});
// ==========================================
// FETCH STUDY MATERIALS LIST
// ==========================================
app.get('/api/study-materials', (req, res) => {
    const { standard, subject, type } = req.query;
    
    const query = `SELECT id, topic FROM study_materials WHERE standard = ? AND subject = ? AND material_type = ?`;
    
    db.query(query, [standard, subject, type], (err, results) => {
        if (err) {
            console.error('Error fetching materials:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});
// ==========================================
// FETCH DYNAMIC TOPICS FOR PRACTICE ZONE
// ==========================================
app.get('/api/fetch-topics', (req, res) => {
    const { standard, exam, subject } = req.query;

    if (!standard || !exam || !subject) {
        return res.status(400).json({ error: 'Missing filter parameters' });
    }

    // We use SELECT DISTINCT so that if a topic has 100 questions, 
    // the database only sends the topic name back once!
    const query = `
        SELECT DISTINCT topic 
        FROM mcq_questions 
        WHERE standard = ? AND exam = ? AND subject = ?
        ORDER BY topic ASC
    `;

    db.query(query, [standard, exam, subject], (err, results) => {
        if (err) {
            console.error('Error fetching topics:', err);
            return res.status(500).json({ error: 'Database error while fetching topics' });
        }
        
        // This will send back an array of topics to Practice_zone.js
        // Example: [ { topic: 'Rotational Dynamics' }, { topic: 'Kinematics' } ]
        res.json(results);
    });
});
// ==========================================
// FETCH MCQS FOR PRACTICE ZONE
// ==========================================
app.get('/api/fetch-mcqs', (req, res) => {
    const { standard, exam, subject, topic } = req.query;

    if (!standard || !exam || !subject || !topic) {
        return res.status(400).json({ error: 'Missing filter parameters' });
    }

    const query = `
        SELECT id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation 
        FROM mcq_questions 
        WHERE standard = ? AND exam = ? AND subject = ? AND topic = ?
    `;

    db.query(query, [standard, exam, subject, topic], (err, results) => {
        if (err) {
            console.error('Error fetching MCQs:', err);
            return res.status(500).json({ error: 'Database error while fetching questions' });
        }
        res.json(results);
    });
});
const { v4: uuidv4 } = require('uuid');

// ==========================================
// ADMIN: GENERATE UNLOCK TOKEN
// ==========================================
app.post('/api/admin/generate-unlock-token', verifyAdmin, async (req, res) => {
    try {
        const token = "SA-" + Math.random().toString(36).substring(2, 10).toUpperCase();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour expiry

        await db.promise().query(
    `INSERT INTO unlock_tokens (token, expires_at, is_used, created_at) VALUES (?, ?, false, NOW())`,
    [token, expiresAt]
);

        res.json({ success: true, token });

    } catch (error) {
        console.error("Token Generation Error:", error);
        res.status(500).json({ success: false });
    }
});

app.post('/api/validate-unlock-token', async (req, res) => {
    const { token } = req.body;

    try {
        const [rows] = await db.promise().query(
            `SELECT * FROM unlock_tokens WHERE token = ?`,
            [token]
        );

        if (rows.length === 0) {
            return res.json({ success: false, error: "Invalid token" });
        }

        const tokenData = rows[0];

        if (tokenData.is_used) {
            return res.json({ success: false, error: "Token already used" });
        }

        if (new Date(tokenData.expires_at) < new Date()) {
            return res.json({ success: false, error: "Token expired" });
        }

        await db.promise().query(
            `UPDATE unlock_tokens SET is_used = TRUE WHERE id = ?`,
            [tokenData.id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error("Unlock Token Error:", error);
        res.status(500).json({ success: false, error: "Server error" });
    }
});
// ==========================================
// AUTO DELETE EXPIRED UNLOCK TOKENS
// Runs Every 1 Hour
// ==========================================

cron.schedule('0 * * * *', async () => {
    try {
        console.log("🧹 Running token cleanup job...");

        const [result] = await db.promise().query(
            `DELETE FROM unlock_tokens WHERE expires_at < NOW()`
        );

        console.log(`✅ Deleted ${result.affectedRows} expired tokens`);

    } catch (error) {
        console.error("❌ Token cleanup failed:", error);
    }
});