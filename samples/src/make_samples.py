"""Generate sample PDFs: form.pdf, pages.pdf. (paper.pdf comes from paper.tex, scan.pdf from make_scan.mjs)"""
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

W, H = A4

def form():
    c = canvas.Canvas("../../public/samples/form.pdf", pagesize=A4)
    c.setTitle("Registration form")
    c.setFont("Helvetica-Bold", 18); c.drawString(60, H - 70, "Lab Access Registration")
    c.setFont("Helvetica", 10); c.drawString(60, H - 88, "Please fill in all fields and sign at the bottom.")
    f = c.acroForm
    y = H - 140
    for label, name in [("Full name", "name"), ("Email", "email"), ("Institute", "institute"), ("Start date", "start")]:
        c.setFont("Helvetica", 11); c.drawString(60, y + 5, label)
        f.textfield(name=name, x=170, y=y, width=320, height=20, borderColor=HexColor("#888888"), fillColor=HexColor("#ffffff"), fontSize=11)
        y -= 40
    c.drawString(60, y + 5, "Role")
    f.choice(name="role", value="PhD student", options=["PhD student", "Postdoc", "Staff", "Guest"], x=170, y=y, width=200, height=20, fontSize=11)
    y -= 45
    c.drawString(60, y + 5, "Needs cleanroom access")
    f.checkbox(name="cleanroom", x=230, y=y, size=16, checked=False)
    y -= 35
    c.drawString(60, y + 5, "Safety training done")
    f.checkbox(name="training", x=230, y=y, size=16, checked=True)
    y -= 40
    c.drawString(60, y + 5, "Building")
    for i, b in enumerate(["01.4", "02.1", "15.2"]):
        f.radio(name="building", value=b, selected=(i == 0), x=170 + i * 80, y=y, size=16)
        c.drawString(190 + i * 80, y + 4, b)
    y -= 50
    c.drawString(60, y + 5, "Comments")
    f.textfield(name="comments", x=170, y=y - 40, width=320, height=60, fieldFlags="multiline", borderColor=HexColor("#888888"), fontSize=10)
    y -= 110
    c.line(60, y, 300, y); c.setFont("Helvetica", 9); c.drawString(60, y - 12, "Signature")
    c.line(340, y, 490, y); c.drawString(340, y - 12, "Date")
    c.showPage(); c.save()

def pages():
    c = canvas.Canvas("../../public/samples/pages.pdf", pagesize=A4)
    colors = ["#e63946", "#2a9d8f", "#457b9d", "#f4a261", "#6a4c93"]
    for i, col in enumerate(colors, 1):
        c.setFillColor(HexColor(col)); c.rect(0, H - 120, W, 120, fill=1, stroke=0)
        c.setFillColor(HexColor("#ffffff")); c.setFont("Helvetica-Bold", 40); c.drawString(50, H - 85, f"Page {i}")
        c.setFillColor(HexColor("#222222")); c.setFont("Helvetica", 12)
        c.drawString(50, H - 170, f"This is page {i} of 5, used to test reordering, rotating and deleting.")
        c.showPage()
    c.save()

form(); pages()
