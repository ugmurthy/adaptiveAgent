adaptive-agent run \
   "You have the following tasks \
    1. list your capabilities 
    2. Transcribe the audio \
    3. Evaluate the sketch, \ 
    4. Get me the latest news current IPL 2026 match between RR and what is your prediction on winner. \
    5. extract text from the attached PDF file. \
         attached as a image  and provide feedback " \
    --progress \
    --orchestrate \
    --catalog ~/.adaptiveAgent/agents/ipl-agent.json \
    --catalog specs/audio-agent.json \
    --catalog ~/.adaptiveAgent/agents/sketch-mentor.json \
    --image specs/lips.jpg \
    --image specs/eye.jpeg \
    --audio specs/sample.mp3 \
    --file-attachment specs/sample-doc.pdf
    
