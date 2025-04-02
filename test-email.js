const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: 's74143636@gmail.com',
    pass:  'buwvrxvnbzxjzxyn', // Replace with your current App Password if different
  },
  tls: {
    rejectUnauthorized: false,
  },
});

transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP verification error:', error);
  } else {
    console.log('SMTP server is ready to send emails');

    const mailOptions = {
      from: 'girendrajhastm@gmail.com',
      to: 'turemedicine@gmail.com',
      subject: 'Test Email from Standalone Script',
      text: 'This is a test email to verify SMTP credentials.',
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error('Email sending error:', err);
      } else {
        console.log('Email sent successfully:', info.response);
      }
    });
  }
});