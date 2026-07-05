const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const sendAdminActivationEmail = async (email, name, token, frontendUrl = 'http://localhost:3000') => {
  const activationLink = `${frontendUrl}/set-password?token=${token}&email=${encodeURIComponent(email)}`;
  
  const mailOptions = {
    from: process.env.SMTP_FROM || '"HexTorq Examinations" <noreply@hextorq.com>',
    to: email,
    subject: 'Welcome to HexTorq Examinations - Activate Your Admin Account',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome, ${name}!</h2>
        <p>You have been invited to join HexTorq Examinations as an Administrator.</p>
        <p>To activate your account and set your password, please click the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${activationLink}" style="background-color: #9333ea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Set My Password</a>
        </div>
        <p>Or copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color: #666;"><a href="${activationLink}">${activationLink}</a></p>
        <p>This link will expire in 24 hours.</p>
        <hr style="border: none; border-top: 1px solid #eaeaea; margin: 30px 0;" />
        <p style="font-size: 12px; color: #888;">If you did not request this invitation, you can safely ignore this email.</p>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Activation email sent: %s', info.messageId);
    return info;
  } catch (error) {
    console.error('Error sending activation email:', error);
    throw error;
  }
};

module.exports = {
  sendAdminActivationEmail,
};
