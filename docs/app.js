const status = document.querySelector("#copy-status");
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const command = button.dataset.copy;
    try { await navigator.clipboard.writeText(command); }
    catch {
      const field = document.createElement("textarea");
      field.value = command; document.body.append(field); field.select();
      document.execCommand("copy"); field.remove();
    }
    const label = button.querySelector("span");
    const original = label.textContent;
    label.textContent = "Copied";
    status.textContent = "Install command copied.";
    setTimeout(() => { label.textContent = original; }, 1600);
  });
});
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const moving = document.querySelector("#moving-status");
  setTimeout(() => { moving.textContent = "DELIVERED"; moving.classList.add("done"); }, 4800);
}
