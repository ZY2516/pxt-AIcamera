AIcamera.setDeviceI2CAddress(0x60)
AIcamera.switchTo(AIcamera.AppMode.FaceRecognize)

basic.forever(function () {
    AIcamera.refreshFaceResult()
    serial.writeLine("face=" + AIcamera.faceLabel() + " conf=" + AIcamera.faceSimilarity())
    basic.pause(300)
})
