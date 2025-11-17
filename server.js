const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '.'))); // HTML 파일들이 있는 현재 폴더 연결
app.use(cors());

// ⚠️ [중요] 여기 비밀번호를 본인 MySQL 비밀번호로 꼭 바꾸세요!
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'wowxc',  // <-- 여기를 수정하세요 (예: '1234')
    database: 'chatgpt_clone'
});

db.connect((err) => {
    if (err) {
        console.error('DB 연결 실패 ㅠㅠ:', err);
    } else {
        console.log('✅ MySQL 데이터베이스 연결 성공!');
    }
});

// 1. 회원가입 API
app.post('/api/signup', async (req, res) => {
    const { name, email, password, apiKey } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10); // 비밀번호 암호화
        const sql = 'INSERT INTO users (name, email, password, api_key) VALUES (?, ?, ?, ?)';
        
        db.query(sql, [name, email, hashedPassword, apiKey], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ message: '이미 있는 이메일입니다.' });
                return res.status(500).json({ message: 'DB 에러 발생' });
            }
            res.status(201).json({ message: '가입 성공' });
        });
    } catch (error) {
        res.status(500).json({ message: '서버 에러' });
    }
});

// 2. 로그인 API
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const sql = 'SELECT * FROM users WHERE email = ?';
    
    db.query(sql, [email], (err, results) => {
        if (err) return res.status(500).json({ message: '서버 에러' });
        if (results.length === 0) return res.status(401).json({ message: '이메일이 없습니다.' });

        const user = results[0];
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (isMatch) {
                res.status(200).json({ 
                    message: '로그인 성공', 
                    user: { id: user.id, name: user.name, apiKey: user.api_key } 
                });
            } else {
                res.status(401).json({ message: '비밀번호가 틀렸습니다.' });
            }
        });
    });
});

app.listen(3000, () => {
    console.log('🚀 서버가 실행되었습니다: http://localhost:3000');
});