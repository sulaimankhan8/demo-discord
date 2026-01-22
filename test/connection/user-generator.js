"use strict";

const users = [
  { id: "d9847b7d-9d1b-4ad3-babf-032753058bd8", username: "user1" },
  { id: "78a2e686-cd60-47a3-88ca-1e48cb2fd766", username: "user2" },
  { id: "6e985b49-4fbc-4df7-8a33-433c526da2fd", username: "user3" },
  { id: "8bcc919d-42a5-49ff-9c62-38a92b56d2b6", username: "user4" },
  { id: "c0a3d549-cad9-4322-9f5e-01493aa4dcbe", username: "user5" },
  { id: "add9134f-7ec6-4a8f-b104-7fbc5ab3d991", username: "user6" },
  { id: "c7624224-6ef5-4ebb-8eb0-d9e4dfb286fd", username: "user7" },
  { id: "de446227-7216-47ba-97b6-2af07e56ec24", username: "user8" },
  { id: "53d1c36c-93bd-4280-9d9f-327a7ed67634", username: "user9" },
  { id: "727adda7-6bc5-4d75-af29-78018f2271ef", username: "user10" },
];

module.exports = {
  pickUser: function (context, events, done) {
    const user = users[Math.floor(Math.random() * users.length)];

    context.vars.userId = user.id;
    context.vars.username = user.username;

    return done();
  },
};
