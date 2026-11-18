let count = 0;
nexterm.onCommand("show", () => nexterm.views.open("hello"));
nexterm.handle("increment", async () => {
  count++;
  await nexterm.status.update("hello-status", `Hello ${count}`);
  await nexterm.publish("count", count);
  return count;
});
