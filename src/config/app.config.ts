import express from 'express';
import cors from 'cors';
import compression from 'compression';

// export function createApp() {
//     const app = express();

//     const allowedOrigins = ['http://localhost:3000', 'http://localhost:5173'];

//     app.use(cors({
//         origin: function (origin,  callback) {
//             if(!origin) return callback(null, true);
//             if(allowedOrigins.includes(origin)){
//                 callback(null, true);
//             } else {
//                 callback(new Error('Not allowed by CORS'));
//             }

//         },
//         credentials: true

//     })
// );
// app.use(express.json());

// return app;
// }

export function createApp() {
    const app = express();

    app.use(compression());
    app.use(cors({
      origin: true,   // sab origins allow
      credentials: true
    }));

    // verify callback preserves the raw request body on req.rawBody so the
    // webhook engine can verify HMAC / Ed25519 signatures over the exact bytes
    // the vendor signed.
    app.use(express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    }));

    return app;
  }